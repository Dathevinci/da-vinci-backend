import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { isLeadDevFree } from "./card.controller";
import { CARDS } from "../data/cardCatalog";
import {
  DUNGEONS, PARTY_MAX, INJURY_THRESHOLD, HEAL_COST_AP, REVIVE_COST_AP,
  DungeonState, DgnUnit, makeUnit, simulateFloor, partyPower,
} from "../data/dungeonRules";

/**
 * DUNGEON DISPATCH — the second game mode, alongside Card Duels.
 *
 * The same three laws the duels live by:
 *  · The engine is server-side only. The client posts intents (dispatch,
 *    advance, recall) and animates the events it is handed back.
 *  · Every money move is an atomic conditional updateMany; every state
 *    transition is guarded on the row's CURRENT status inside a transaction,
 *    so a double-submit can never bank twice or advance twice.
 *  · Nothing is deleted. A dead card is revivable for Arise Points — death
 *    just has to cost more than the run it happened in earned.
 */

function guard(req: Request, res: Response, userId?: string): boolean {
  if (!userId) {
    res.status(400).json({ success: false, message: "Missing userId." });
    return false;
  }
  const actor = getActorId(req);
  if (actor && actor !== userId) {
    res.status(403).json({ success: false, message: "You can only act as yourself." });
    return false;
  }
  return true;
}

class DgnError extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

/**
 * Write a finished party's condition back onto the cards. Runs inside the
 * finalizing transaction so the run's outcome and the cards' state can never
 * disagree. Injury is one-way here: it sets on a bad return and only a paid
 * heal clears it.
 */
async function writeBackParty(tx: any, userId: string, party: DgnUnit[]): Promise<void> {
  for (const u of party) {
    if (u.hp <= 0) {
      await tx.userCard.updateMany({
        where: { userId, cardId: u.cardId },
        data: { dgnDead: true, dgnHp: 0 },
      });
    } else {
      const injuredNow = u.hp < u.maxHp * INJURY_THRESHOLD;
      await tx.userCard.updateMany({
        where: { userId, cardId: u.cardId },
        data: {
          dgnHp: u.hp >= u.maxHp ? null : u.hp,
          ...(injuredNow ? { dgnInjured: true } : {}),
        },
      });
    }
  }
}

/** The per-unit outcome list the results screen renders. */
function partyOutcomes(party: DgnUnit[]) {
  return party.map((u) => ({
    cardId: u.cardId,
    name: u.name,
    rarity: u.rarity,
    hp: Math.max(0, u.hp),
    maxHp: u.maxHp,
    outcome: u.hp <= 0 ? "died" : u.hp >= u.maxHp ? "unscathed" : u.hp < u.maxHp * INJURY_THRESHOLD ? "injured" : "wounded",
  }));
}

// ── GET /api/dungeon/status/:userId ─────────────────────────────────────────
// Everything the lobby needs in one read: dungeon defs, every owned unit's
// dungeon condition, costs, and any run still in flight (for resume).
export const getStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.userId as string;
    const [rows, activeRun] = await Promise.all([
      prisma.userCard.findMany({
        where: { userId },
        select: { cardId: true, count: true, foil: true, level: true, dgnHp: true, dgnInjured: true, dgnDead: true },
      }),
      prisma.dungeonRun.findFirst({ where: { userId, status: "RUNNING" }, orderBy: { createdAt: "desc" } }),
    ]);
    const cards = rows
      .filter((r) => { const d = CARDS[r.cardId]; return d && !d.support; })
      .map((r) => ({
        cardId: r.cardId, count: r.count, foil: r.foil, level: r.level,
        dgnHp: r.dgnHp, dgnInjured: r.dgnInjured, dgnDead: r.dgnDead,
      }));
    res.json({
      success: true,
      data: {
        dungeons: Object.values(DUNGEONS),
        cards,
        activeRun,
        partyMax: PARTY_MAX,
        healCost: HEAL_COST_AP,
        reviveCost: REVIVE_COST_AP,
      },
    });
  } catch (error) { next(error); }
};

// ── POST /api/dungeon  { userId, dungeon, cardIds[] } ──────────────────────
export const dispatch = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, dungeon, cardIds } = (req.body || {}) as {
      userId?: string; dungeon?: string; cardIds?: string[];
    };
    if (!guard(req, res, userId)) return;
    const def = dungeon ? DUNGEONS[dungeon] : undefined;
    if (!def) return res.status(404).json({ success: false, message: "No such dungeon." });

    const ids = Array.isArray(cardIds) ? [...new Set(cardIds)] : [];
    if (ids.length < 1 || ids.length > PARTY_MAX) {
      return res.status(400).json({ success: false, message: `Pick 1 to ${PARTY_MAX} cards.` });
    }
    for (const id of ids) {
      const c = CARDS[id];
      if (!c) return res.status(400).json({ success: false, message: "Unknown card in the party." });
      if (c.support) return res.status(400).json({ success: false, message: `${c.name} is a support card — it doesn't raid.` });
    }

    const rows = await prisma.userCard.findMany({
      where: { userId, cardId: { in: ids } },
      select: { cardId: true, foil: true, level: true, dgnHp: true, dgnInjured: true, dgnDead: true },
    });
    if (rows.length !== ids.length) {
      return res.status(400).json({ success: false, message: "You don't own every card in that party." });
    }
    const dead = rows.filter((r) => r.dgnDead);
    if (dead.length) {
      return res.status(400).json({
        success: false,
        message: `${dead.map((r) => CARDS[r.cardId]?.name || r.cardId).join(", ")} ${dead.length === 1 ? "is" : "are"} dead. Revive first.`,
      });
    }

    const byId = new Map(rows.map((r) => [r.cardId, r]));
    const party = ids
      .map((id) => { const r = byId.get(id)!; return makeUnit(id, r.level, r.foil, r.dgnHp, r.dgnInjured); })
      .filter((u): u is DgnUnit => !!u);
    if (party.length !== ids.length) {
      return res.status(400).json({ success: false, message: "That party couldn't be formed." });
    }

    const existing = await prisma.dungeonRun.findFirst({ where: { userId, status: "RUNNING" } });
    if (existing) {
      return res.status(409).json({ success: false, message: "A party is already in a dungeon. Recall them first." });
    }

    const state: DungeonState = { dungeon: def.id, floor: 0, party, apEarned: 0, shardsEarned: 0 };
    const run = await prisma.dungeonRun.create({
      data: { userId: userId!, dungeon: def.id, state: JSON.stringify(state) },
    });
    res.status(201).json({ success: true, data: { run, party, power: partyPower(party) } });
  } catch (error) { next(error); }
};

// ── POST /api/dungeon/:id/advance  { userId } ──────────────────────────────
// Resolve ONE floor. Status-guarded so a double-submit can't fight the same
// floor twice; a wipe or a full clear finalizes right here.
export const advance = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req.body || {}) as { userId?: string };
    if (!guard(req, res, userId)) return;
    const id = req.params.id as string;

    const run = await prisma.dungeonRun.findUnique({ where: { id } });
    if (!run) return res.status(404).json({ success: false, message: "Run not found." });
    if (run.userId !== userId) return res.status(403).json({ success: false, message: "Not your run." });
    if (run.status !== "RUNNING") return res.status(410).json({ success: false, message: "That run is over." });

    const def = DUNGEONS[run.dungeon];
    if (!def) return res.status(500).json({ success: false, message: "The dungeon no longer exists." });

    const state: DungeonState = JSON.parse(run.state);
    const { events, wiped } = simulateFloor(state);
    const clearedDungeon = !wiped && state.floor >= def.depth;

    try {
      const out = await prisma.$transaction(async (tx: any) => {
        if (wiped) {
          // Everything unbanked is forfeit; the deaths are not.
          const claim = await tx.dungeonRun.updateMany({
            where: { id, status: "RUNNING" },
            data: {
              status: "WIPED", state: JSON.stringify(state), floor: state.floor,
              apEarned: 0, shardsEarned: 0, finishedAt: new Date(),
            },
          });
          if (claim.count === 0) throw new DgnError(409, "That floor already resolved.");
          await writeBackParty(tx, userId!, state.party);
          return { done: true as const, result: {
            status: "WIPED", floors: state.floor, ap: 0, shards: 0,
            lostAp: state.apEarned, lostShards: state.shardsEarned,
            party: partyOutcomes(state.party),
          } };
        }
        if (clearedDungeon) {
          // Walked out the far side — banks exactly like a recall.
          const claim = await tx.dungeonRun.updateMany({
            where: { id, status: "RUNNING" },
            data: {
              status: "CLEARED", state: JSON.stringify(state), floor: state.floor,
              apEarned: state.apEarned, shardsEarned: state.shardsEarned, finishedAt: new Date(),
            },
          });
          if (claim.count === 0) throw new DgnError(409, "That floor already resolved.");
          await writeBackParty(tx, userId!, state.party);
          await tx.user.update({
            where: { id: userId },
            data: { arisePoints: { increment: state.apEarned }, shards: { increment: state.shardsEarned } },
          });
          await tx.pointLog.create({ data: { userId: userId!, amount: state.apEarned, reason: `dungeon-clear:${id}` } });
          return { done: true as const, result: {
            status: "CLEARED", floors: state.floor, ap: state.apEarned, shards: state.shardsEarned,
            party: partyOutcomes(state.party),
          } };
        }
        const claim = await tx.dungeonRun.updateMany({
          where: { id, status: "RUNNING" },
          data: {
            state: JSON.stringify(state), floor: state.floor,
            apEarned: state.apEarned, shardsEarned: state.shardsEarned,
          },
        });
        if (claim.count === 0) throw new DgnError(409, "That floor already resolved.");
        return { done: false as const };
      });

      res.json({
        success: true,
        data: {
          events,
          floor: state.floor,
          apEarned: state.apEarned,
          shardsEarned: state.shardsEarned,
          party: state.party,
          done: out.done,
          ...(out.done ? { result: (out as any).result } : {}),
        },
      });
    } catch (e) {
      if (e instanceof DgnError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) { next(error); }
};

// ── POST /api/dungeon/:id/recall  { userId } ───────────────────────────────
export const recall = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req.body || {}) as { userId?: string };
    if (!guard(req, res, userId)) return;
    const id = req.params.id as string;

    const run = await prisma.dungeonRun.findUnique({ where: { id } });
    if (!run) return res.status(404).json({ success: false, message: "Run not found." });
    if (run.userId !== userId) return res.status(403).json({ success: false, message: "Not your run." });
    if (run.status !== "RUNNING") return res.status(410).json({ success: false, message: "That run is already over." });

    const state: DungeonState = JSON.parse(run.state);
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        const claim = await tx.dungeonRun.updateMany({
          where: { id, status: "RUNNING" },
          data: { status: "RECALLED", finishedAt: new Date() },
        });
        if (claim.count === 0) throw new DgnError(409, "That run already ended.");
        await writeBackParty(tx, userId!, state.party);
        if (state.apEarned > 0 || state.shardsEarned > 0) {
          await tx.user.update({
            where: { id: userId },
            data: { arisePoints: { increment: state.apEarned }, shards: { increment: state.shardsEarned } },
          });
          if (state.apEarned > 0) {
            await tx.pointLog.create({ data: { userId: userId!, amount: state.apEarned, reason: `dungeon-recall:${id}` } });
          }
        }
        return {
          status: "RECALLED", floors: state.floor, ap: state.apEarned, shards: state.shardsEarned,
          party: partyOutcomes(state.party),
        };
      });
      res.json({ success: true, data: result });
    } catch (e) {
      if (e instanceof DgnError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) { next(error); }
};

// ── POST /api/dungeon/heal  { userId, cardId } ─────────────────────────────
// Full HP and the injury cleared, for a flat AP price. Lead dev heals free —
// the same testing bypass every other sink honours.
export const healCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId } = (req.body || {}) as { userId?: string; cardId?: string };
    if (!guard(req, res, userId)) return;
    const row = await prisma.userCard.findUnique({ where: { userId_cardId: { userId: userId!, cardId: cardId! } } });
    if (!row) return res.status(404).json({ success: false, message: "You don't own that card." });
    if (row.dgnDead) return res.status(400).json({ success: false, message: "It isn't hurt — it's dead. Revive it." });
    if (row.dgnHp === null && !row.dgnInjured) {
      return res.status(400).json({ success: false, message: "Already at full health." });
    }
    const free = await isLeadDevFree(userId!);
    try {
      await prisma.$transaction(async (tx: any) => {
        if (!free) {
          const debit = await tx.user.updateMany({
            where: { id: userId, arisePoints: { gte: HEAL_COST_AP } },
            data: { arisePoints: { decrement: HEAL_COST_AP } },
          });
          if (debit.count === 0) throw new DgnError(402, `Healing costs ${HEAL_COST_AP} AP.`);
          await tx.pointLog.create({ data: { userId: userId!, amount: -HEAL_COST_AP, reason: `dungeon-heal:${cardId}` } });
        }
        await tx.userCard.update({
          where: { userId_cardId: { userId: userId!, cardId: cardId! } },
          data: { dgnHp: null, dgnInjured: false },
        });
      });
      res.json({ success: true });
    } catch (e) {
      if (e instanceof DgnError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) { next(error); }
};

// ── POST /api/dungeon/revive  { userId, cardId } ───────────────────────────
// Back from the dead at half health, injured — alive is not the same as well.
export const reviveCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId } = (req.body || {}) as { userId?: string; cardId?: string };
    if (!guard(req, res, userId)) return;
    const row = await prisma.userCard.findUnique({ where: { userId_cardId: { userId: userId!, cardId: cardId! } } });
    if (!row) return res.status(404).json({ success: false, message: "You don't own that card." });
    if (!row.dgnDead) return res.status(400).json({ success: false, message: "That card isn't dead." });
    const unit = makeUnit(cardId!, row.level, row.foil, null, true);
    if (!unit) return res.status(400).json({ success: false, message: "That card can't raid at all." });
    const halfHp = Math.max(1, Math.round(unit.maxHp * 0.5));
    const free = await isLeadDevFree(userId!);
    try {
      await prisma.$transaction(async (tx: any) => {
        if (!free) {
          const debit = await tx.user.updateMany({
            where: { id: userId, arisePoints: { gte: REVIVE_COST_AP } },
            data: { arisePoints: { decrement: REVIVE_COST_AP } },
          });
          if (debit.count === 0) throw new DgnError(402, `A revival costs ${REVIVE_COST_AP} AP.`);
          await tx.pointLog.create({ data: { userId: userId!, amount: -REVIVE_COST_AP, reason: `dungeon-revive:${cardId}` } });
        }
        // Guarded on still-dead so a double-tap can't pay twice.
        const raised = await tx.userCard.updateMany({
          where: { userId, cardId, dgnDead: true },
          data: { dgnDead: false, dgnInjured: true, dgnHp: halfHp },
        });
        if (raised.count === 0) throw new DgnError(409, "Already revived.");
      });
      res.json({ success: true });
    } catch (e) {
      if (e instanceof DgnError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) { next(error); }
};
