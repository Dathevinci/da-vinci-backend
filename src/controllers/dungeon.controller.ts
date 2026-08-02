import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { isLeadDevFree } from "./card.controller";
import { CARDS } from "../data/cardCatalog";
import {
  DUNGEONS, PARTY_MAX, INJURY_THRESHOLD, HEAL_COST_AP, reviveCost,
  PACK_MAX, DGN_ITEMS, SALVE_HEAL,
  DungeonState, DgnUnit, makeUnit, simulateFloor, partyPower,
} from "../data/dungeonRules";

/** Unused pack items ride home with the survivors — on recall, clear AND
 *  wipe alike: an unopened salve doesn't burn with the camp. */
async function returnPack(tx: any, userId: string, state: DungeonState): Promise<void> {
  const leftovers: string[] = [];
  for (const [itemId, n] of Object.entries(state.items || {})) {
    for (let i = 0; i < n; i++) leftovers.push(itemId);
  }
  if (leftovers.length) {
    await tx.user.update({ where: { id: userId }, data: { duelItems: { push: leftovers } } });
  }
}

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
        data: { dgnDead: true, dgnHp: 0, dgnDeaths: { increment: 1 } },
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
    const [rows, activeRun, bagUser] = await Promise.all([
      prisma.userCard.findMany({
        where: { userId },
        select: { cardId: true, count: true, foil: true, level: true, dgnHp: true, dgnInjured: true, dgnDead: true, dgnDeaths: true },
      }),
      prisma.dungeonRun.findFirst({ where: { userId, status: "RUNNING" }, orderBy: { createdAt: "desc" } }),
      prisma.user.findUnique({ where: { id: userId }, select: { duelItems: true } }),
    ]);
    const cards = rows
      .filter((r) => { const d = CARDS[r.cardId]; return d && !d.support; })
      .map((r) => ({
        cardId: r.cardId, count: r.count, foil: r.foil, level: r.level,
        dgnHp: r.dgnHp, dgnInjured: r.dgnInjured, dgnDead: r.dgnDead,
        dgnDeaths: r.dgnDeaths,
        // Priced PER CARD now: rarity base × how many times this exact card
        // has already died. The client shows the number; this is the truth.
        reviveCost: reviveCost(CARDS[r.cardId]?.rarity || "epic", r.dgnDeaths),
      }));
    res.json({
      success: true,
      data: {
        dungeons: Object.values(DUNGEONS),
        cards,
        activeRun,
        partyMax: PARTY_MAX,
        healCost: HEAL_COST_AP,
        bag: bagUser?.duelItems || [],
        packMax: PACK_MAX,
      },
    });
  } catch (error) { next(error); }
};

// ── POST /api/dungeon  { userId, dungeon, cardIds[] } ──────────────────────
export const dispatch = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, dungeon, cardIds, items } = (req.body || {}) as {
      userId?: string; dungeon?: string; cardIds?: string[]; items?: string[];
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
      select: { cardId: true, foil: true, level: true, skillLevel: true, dgnHp: true, dgnInjured: true, dgnDead: true },
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
    // The spec's rule, adopted: an INJURY blocks the next dispatch. The card
    // can still duel (that arena heals), but the dungeon door is shut until
    // someone pays the infirmary or the injury is healed.
    const hurt = rows.filter((r) => r.dgnInjured);
    if (hurt.length) {
      return res.status(400).json({
        success: false,
        message: `${hurt.map((r) => CARDS[r.cardId]?.name || r.cardId).join(", ")} ${hurt.length === 1 ? "is" : "are"} injured — heal before dispatching again.`,
      });
    }

    const byId = new Map(rows.map((r) => [r.cardId, r]));
    const party = ids
      .map((id) => { const r = byId.get(id)!; return makeUnit(id, r.level, r.foil, r.dgnHp, r.dgnInjured, r.skillLevel); })
      .filter((u): u is DgnUnit => !!u);
    if (party.length !== ids.length) {
      return res.status(400).json({ success: false, message: "That party couldn't be formed." });
    }

    const existing = await prisma.dungeonRun.findFirst({ where: { userId, status: "RUNNING" } });
    if (existing) {
      return res.status(409).json({ success: false, message: "A party is already in a dungeon. Recall them first." });
    }

    // ── THE PACK ── up to three support items from the duel bag, escrowed
    // out of it here so the same Salve can't be packed and dueled at once.
    const wanted = Array.isArray(items) ? items.filter((it) => DGN_ITEMS[it]).slice(0, PACK_MAX) : [];
    const packed: Record<string, number> = {};
    for (const it of wanted) packed[it] = (packed[it] || 0) + 1;

    try {
      const run = await prisma.$transaction(async (tx: any) => {
        if (wanted.length) {
          const u = await tx.user.findUnique({ where: { id: userId }, select: { duelItems: true } });
          const bag: string[] = [...(u?.duelItems || [])];
          for (const it of wanted) {
            const at = bag.indexOf(it);
            if (at === -1) throw new DgnError(400, `You don't have enough ${DGN_ITEMS[it].name}s in the bag.`);
            bag.splice(at, 1);
          }
          await tx.user.update({ where: { id: userId }, data: { duelItems: { set: bag } } });
        }
        const state: DungeonState = {
          dungeon: def.id, floor: 0, party, apEarned: 0, shardsEarned: 0,
          ...(wanted.length ? { items: packed } : {}),
        };
        return tx.dungeonRun.create({
          data: { userId: userId!, dungeon: def.id, state: JSON.stringify(state) },
        });
      });
      res.status(201).json({ success: true, data: { run, party, power: partyPower(party), items: packed } });
    } catch (e) {
      if (e instanceof DgnError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) { next(error); }
};

// ── POST /api/dungeon/:id/use-item  { userId, item } ───────────────────────
// The player's ONLY lever besides recall: throw a packed support item down
// to the party, any time the run is live. A salve lands NOW on whoever is
// worst off; a ward or focus is armed and spent by the NEXT floor's opening.
// Status-guarded write, so racing a floor resolution can't duplicate a use.
export const useItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, item } = (req.body || {}) as { userId?: string; item?: string };
    if (!guard(req, res, userId)) return;
    const id = req.params.id as string;
    const def = item ? DGN_ITEMS[item] : undefined;
    if (!def) return res.status(400).json({ success: false, message: "Unknown item." });

    const run = await prisma.dungeonRun.findUnique({ where: { id } });
    if (!run) return res.status(404).json({ success: false, message: "Run not found." });
    if (run.userId !== userId) return res.status(403).json({ success: false, message: "Not your run." });
    if (run.status !== "RUNNING") return res.status(410).json({ success: false, message: "That run is over." });

    const state: DungeonState = JSON.parse(run.state);
    const have = state.items?.[item!] || 0;
    if (have <= 0) return res.status(400).json({ success: false, message: `No ${def.name} left in the pack.` });

    let note = "";
    if (item === "heal") {
      const living = state.party.filter((u) => u.hp > 0);
      if (!living.length) return res.status(400).json({ success: false, message: "Nobody left to heal." });
      const worst = living.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
      const healed = Math.min(worst.maxHp - worst.hp, SALVE_HEAL);
      if (healed <= 0) return res.status(400).json({ success: false, message: "Nobody is hurt right now." });
      worst.hp += healed;
      note = `> a salve reaches ${worst.name} — +${healed} HP.`;
    } else if (item === "shield") {
      if (state.pendingWard) return res.status(400).json({ success: false, message: "A ward is already held over them." });
      state.pendingWard = 2;
      note = "> a ward is armed — it will hold at the next floor.";
    } else if (item === "focus") {
      if (state.pendingFocus) return res.status(400).json({ success: false, message: "Focus is already taken." });
      state.pendingFocus = true;
      note = "> focus is armed — the next opening volley will hit 75% harder.";
    }
    state.items![item!] = have - 1;

    const claim = await prisma.dungeonRun.updateMany({
      where: { id, status: "RUNNING" },
      data: { state: JSON.stringify(state) },
    });
    if (claim.count === 0) return res.status(409).json({ success: false, message: "The run just ended." });

    res.json({ success: true, data: { party: state.party, items: state.items, note } });
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
          await returnPack(tx, userId!, state);
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
          await returnPack(tx, userId!, state);
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
        await returnPack(tx, userId!, state);
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
    // dgnDeaths was already incremented when it fell, so "prior deaths" for
    // pricing THIS revival is deaths - 1: the first death pays the base.
    const price = reviveCost(CARDS[cardId!]?.rarity || "epic", Math.max(0, (row.dgnDeaths ?? 1) - 1));
    const free = await isLeadDevFree(userId!);
    try {
      await prisma.$transaction(async (tx: any) => {
        if (!free) {
          const debit = await tx.user.updateMany({
            where: { id: userId, arisePoints: { gte: price } },
            data: { arisePoints: { decrement: price } },
          });
          if (debit.count === 0) throw new DgnError(402, `This revival costs ${price} AP.`);
          await tx.pointLog.create({ data: { userId: userId!, amount: -price, reason: `dungeon-revive:${cardId}` } });
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
