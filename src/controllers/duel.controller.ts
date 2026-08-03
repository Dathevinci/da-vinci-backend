import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { isLeadDevFree } from "./card.controller";
import { CARDS } from "../data/cardCatalog";
import {
  DECK_SIZE, ITEMS, ItemId, DuelState, makeSide, applyAction, sideOf,
  eloDelta, payout, MIN_STAKE, MAX_STAKE, DUEL_EXPIRY_HOURS, forfeitFine, SUPPORTS_PER_DUEL,
} from "../data/duelRules";

/**
 * RANKED CARD DUELS — staked, Elo-rated, server-authoritative.
 *
 * Money rules, learned the hard way from the auction review:
 *  · Both stakes are ESCROWED at accept time with a conditional updateMany
 *    (`where arisePoints >= stake`), so check + deduct are one atomic op and a
 *    player can't fund two duels with the same points.
 *  · The house burns a rake off the pot, so competitive play is a SINK rather
 *    than points sloshing between the same handful of people.
 *  · Every state transition is guarded on the row's CURRENT status inside the
 *    transaction, so a double-submit can't pay out twice.
 *
 * The rules engine (duelRules.ts) is pure and server-only — the client posts an
 * intent ("attack", "use heal"), never a result.
 */

/**
 * One health-over-time point per RESOLVED action. The log can't power a
 * post-match graph — it is capped at 60 lines, so a long fight's opening
 * would be invented — but this is appended by the same code that persists
 * the state, so it is exactly as authoritative. Capped generously: a duel
 * physically can't outlive ~200 meaningful actions.
 */
function recordTimeline(s: DuelState): void {
  const sum = (side: { fighters: { hp: number }[] }) =>
    side.fighters.reduce((n, f) => n + Math.max(0, f.hp), 0);
  const t = (s.timeline ||= []);
  t.push({ a: sum(s.a), b: sum(s.b) });
  if (t.length > 240) s.timeline = t.slice(-240);
}

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

/**
 * A deck must be exactly DECK_SIZE distinct, real, FIELDABLE cards.
 *
 * The support-card check is the important one. Support cards have no stat line,
 * so makeSide/buildFighter silently drop them — a deck of three supports yields
 * a side with ZERO fighters. Neither player can ever act, the duel never
 * finishes, and because both stakes are escrowed on accept there is no code path
 * that ever gives those Arise Points back. The client filters supports out of
 * the deck picker, but the client is not a security boundary and a direct POST
 * would strand real points.
 *
 * Returns a player-facing message, or null when the deck is fine.
 */
function deckProblem(deck: any): string | null {
  if (!Array.isArray(deck) || deck.length !== DECK_SIZE) {
    return `Pick exactly ${DECK_SIZE} cards.`;
  }
  if (new Set(deck).size !== deck.length) {
    return `Your deck must be ${DECK_SIZE} different cards.`;
  }
  for (const id of deck) {
    const def = CARDS[id];
    if (!def) return "There's a card in that deck that doesn't exist.";
    if (def.support) {
      return `${def.name} is a support card — it's played during a duel, not fielded. Pick three fighters.`;
    }
  }
  return null;
}

async function ratingFor(userId: string, username: string) {
  return prisma.duelRating.upsert({
    where: { userId },
    create: { userId, username },
    update: { username },
  });
}

// GET /api/duels/leaderboard
export const leaderboard = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await prisma.duelRating.findMany({
      orderBy: [{ rating: "desc" }, { wins: "desc" }],
      take: 50,
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
};

// GET /api/duels/mine/:userId — everything involving me, newest first.
export const myDuels = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.userId as string;
    // Expire stale invitations lazily (Render sleeps; no cron to lean on).
    await prisma.duel.updateMany({
      where: { status: "PENDING", expiresAt: { lte: new Date() } },
      data: { status: "EXPIRED" },
    });
    const duels = await prisma.duel.findMany({
      where: { OR: [{ challengerId: userId }, { opponentId: userId }] },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    const rating = await prisma.duelRating.findUnique({ where: { userId } });
    res.json({ success: true, data: { duels, rating } });
  } catch (error) {
    next(error);
  }
};

// GET /api/duels/:id
export const getDuel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const duel = await prisma.duel.findUnique({ where: { id: req.params.id as string } });
    if (!duel) return res.status(404).json({ success: false, message: "Duel not found." });
    res.json({ success: true, data: duel });
  } catch (error) {
    next(error);
  }
};

// POST /api/duels  { userId, opponentUsername, stake, deck[] }
// Creates the invitation. The challenger's stake is escrowed NOW so an
// invitation is always funded — nobody accepts a duel the other side can't pay.
export const createDuel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, opponentUsername, stake, deck } = (req.body || {}) as {
      userId?: string; opponentUsername?: string; stake?: number; deck?: string[];
    };
    if (!guard(req, res, userId)) return;

    const amount = Math.floor(Number(stake) || 0);
    if (amount < MIN_STAKE || amount > MAX_STAKE) {
      return res.status(400).json({ success: false, message: `Stake must be between ${MIN_STAKE} and ${MAX_STAKE} Arise Points.` });
    }
    // `!deck` is redundant at runtime (deckProblem already rejects a non-array)
    // but it is what narrows `deck` from `string[] | undefined` to `string[]`
    // for everything below — extracting the checks into a helper moved the
    // narrowing out of the compiler's view.
    const bad = deckProblem(deck);
    if (bad || !deck) {
      return res.status(400).json({ success: false, message: bad ?? `Pick exactly ${DECK_SIZE} cards.` });
    }

    const [me, foe] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true } }),
      prisma.user.findFirst({
        where: { username: { equals: (opponentUsername || "").trim(), mode: "insensitive" } },
        select: { id: true, username: true },
      }),
    ]);
    if (!me) return res.status(404).json({ success: false, message: "User not found." });
    if (!foe) return res.status(404).json({ success: false, message: `No user named "${opponentUsername}".` });
    if (foe.id === me.id) return res.status(400).json({ success: false, message: "You can't duel yourself." });

    // You must actually own the cards you're fielding.
    const owned = await prisma.userCard.findMany({
      where: { userId, cardId: { in: deck } },
      select: { cardId: true, hibernating: true },
    });
    if (owned.length !== deck.length) {
      return res.status(400).json({ success: false, message: "You don't own every card in that deck." });
    }
    const asleep = owned.filter((c) => c.hibernating).map((c) => CARDS[c.cardId]?.name || c.cardId);
    if (asleep.length) {
      return res.status(400).json({
        success: false,
        message: `${asleep.join(", ")} ${asleep.length === 1 ? "is" : "are"} hibernating. Wake ${asleep.length === 1 ? "it" : "them"} with shards, or pull another copy.`,
      });
    }

    try {
      const duel = await prisma.$transaction(async (tx) => {
        const debit = await tx.user.updateMany({
          where: { id: userId, arisePoints: { gte: amount } },
          data: { arisePoints: { decrement: amount } },
        });
        if (debit.count === 0) throw new DuelError(402, `You need ${amount.toLocaleString()} Arise Points to stake this duel.`);
        await tx.pointLog.create({ data: { userId: userId!, amount: -amount, reason: "duel-stake" } });

        const created = await tx.duel.create({
          data: {
            challengerId: me.id, challengerName: me.username,
            opponentId: foe.id, opponentName: foe.username,
            stake: amount, challengerDeck: deck,
            expiresAt: new Date(Date.now() + DUEL_EXPIRY_HOURS * 3600 * 1000),
          },
        });
        await tx.notification.create({
          data: {
            userId: foe.id, actorId: me.id, type: "duel",
            message: `⚔️ ${me.username} challenged you to a ${amount.toLocaleString()} AP duel!`,
            link: "/duels",
          },
        });
        return created;
      });
      res.status(201).json({ success: true, data: duel });
    } catch (e) {
      if (e instanceof DuelError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/duels/:id/accept  { userId, deck[] }
export const acceptDuel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, deck } = (req.body || {}) as { userId?: string; deck?: string[] };
    if (!guard(req, res, userId)) return;
    const id = req.params.id as string;

    const duel = await prisma.duel.findUnique({ where: { id } });
    if (!duel) return res.status(404).json({ success: false, message: "Duel not found." });
    if (duel.opponentId !== userId) return res.status(403).json({ success: false, message: "This challenge isn't yours to accept." });
    if (duel.status !== "PENDING") return res.status(410).json({ success: false, message: "This challenge is no longer open." });
    if (duel.expiresAt.getTime() <= Date.now()) return res.status(410).json({ success: false, message: "This challenge expired." });
    // `!deck` narrows to string[] for the spread and includes() calls below.
    const badDeck = deckProblem(deck);
    if (badDeck || !deck) {
      return res.status(400).json({ success: false, message: badDeck ?? `Pick exactly ${DECK_SIZE} cards.` });
    }

    // A challenge sent before the deck size changed would pit their old
    // smaller deck against the accepter's full one — an unfair fight nobody
    // asked for. Retire it and give the challenger their stake back rather
    // than leaving a dead challenge sitting on their points.
    if (duel.challengerDeck.length !== DECK_SIZE) {
      await prisma.$transaction(async (tx) => {
        const claim = await tx.duel.updateMany({
          where: { id, status: "PENDING" },
          data: { status: "DECLINED", finishedAt: new Date() },
        });
        if (claim.count === 0) return;
        await tx.user.update({ where: { id: duel.challengerId }, data: { arisePoints: { increment: duel.stake } } });
        await tx.pointLog.create({ data: { userId: duel.challengerId, amount: duel.stake, reason: `duel-refund:${id}` } });
      });
      return res.status(410).json({
        success: false,
        message: `That challenge was made when decks were ${duel.challengerDeck.length} cards. It's been cancelled and ${duel.challengerName} refunded — ask them for a fresh one.`,
      });
    }

    const ownedRows = await prisma.userCard.findMany({
      where: { userId, cardId: { in: [...deck, ...duel.challengerDeck] } },
      select: { cardId: true, foil: true, hibernating: true, level: true, skillLevel: true, atkForge: true, hpForge: true },
    });
    if (ownedRows.filter((r) => deck.includes(r.cardId)).length !== deck.length) {
      return res.status(400).json({ success: false, message: "You don't own every card in that deck." });
    }
    const dozing = ownedRows
      .filter((r) => deck.includes(r.cardId) && r.hibernating)
      .map((r) => CARDS[r.cardId]?.name || r.cardId);
    if (dozing.length) {
      return res.status(400).json({
        success: false,
        message: `${dozing.join(", ")} ${dozing.length === 1 ? "is" : "are"} hibernating. Wake ${dozing.length === 1 ? "it" : "them"} with shards, or pull another copy.`,
      });
    }
    // Levels are read for BOTH sides, not just foils. A level is shard-bought
    // power; if it were only applied to one side — or dropped here — the
    // upgrade would be a number on a card page that never reached a fight.
    const challengerRows = await prisma.userCard.findMany({
      where: { userId: duel.challengerId, cardId: { in: duel.challengerDeck } },
      select: { cardId: true, foil: true, level: true, skillLevel: true, atkForge: true, hpForge: true },
    });
    const challengerLevels: Record<string, number> = {};
    for (const r of challengerRows) challengerLevels[r.cardId] = r.level || 1;
    const myLevels: Record<string, number> = {};
    for (const r of ownedRows) myLevels[r.cardId] = r.level || 1;
    // Ability ranks travel with the fighter for the same reason levels do: a
    // rank that only changed a number on the card page would be a shard sink
    // that never reached a fight.
    const challengerSkills: Record<string, number> = {};
    for (const r of challengerRows) challengerSkills[r.cardId] = (r as any).skillLevel || 1;
    const mySkills: Record<string, number> = {};
    for (const r of ownedRows) mySkills[r.cardId] = (r as any).skillLevel || 1;
    // Forge ranks travel for the same reason levels and ranks do: a shard
    // sink that never reaches a fight sells nothing.
    const challengerAtkF: Record<string, number> = {};
    const challengerHpF: Record<string, number> = {};
    for (const r of challengerRows) { challengerAtkF[r.cardId] = (r as any).atkForge || 0; challengerHpF[r.cardId] = (r as any).hpForge || 0; }
    const myAtkF: Record<string, number> = {};
    const myHpF: Record<string, number> = {};
    for (const r of ownedRows) { myAtkF[r.cardId] = (r as any).atkForge || 0; myHpF[r.cardId] = (r as any).hpForge || 0; }

    const stateObj: DuelState = {
      a: makeSide(duel.challengerId, duel.challengerName, duel.challengerDeck,
        new Set(challengerRows.filter((r) => r.foil).map((r) => r.cardId)), {}, challengerLevels, challengerSkills, challengerAtkF, challengerHpF),
      b: makeSide(duel.opponentId, duel.opponentName, deck,
        new Set(ownedRows.filter((r) => r.foil).map((r) => r.cardId)), {}, myLevels, mySkills, myAtkF, myHpF),
      turn: duel.challengerId, // challenger moves first
      log: [`${duel.opponentName} accepted the challenge.`],
      round: 1,
    };
    // First timeline point: both lines at full health. Every resolved move
    // appends another — see recordTimeline.
    recordTimeline(stateObj);

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const debit = await tx.user.updateMany({
          where: { id: userId, arisePoints: { gte: duel.stake } },
          data: { arisePoints: { decrement: duel.stake } },
        });
        if (debit.count === 0) throw new DuelError(402, `You need ${duel.stake.toLocaleString()} Arise Points to match this stake.`);
        await tx.pointLog.create({ data: { userId: userId!, amount: -duel.stake, reason: "duel-stake" } });

        // Guarded on PENDING so a double-accept can't double-charge.
        const claim = await tx.duel.updateMany({
          where: { id, status: "PENDING" },
          data: {
            status: "ACTIVE", opponentDeck: deck,
            state: JSON.stringify(stateObj), turnUserId: duel.challengerId,
          },
        });
        if (claim.count === 0) throw new DuelError(410, "This challenge is no longer open.");
        return tx.duel.findUnique({ where: { id } });
      });
      res.json({ success: true, data: updated });
    } catch (e) {
      if (e instanceof DuelError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/duels/:id/decline  { userId } — refunds the challenger's stake.
export const declineDuel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req.body || {}) as { userId?: string };
    if (!guard(req, res, userId)) return;
    const id = req.params.id as string;

    const duel = await prisma.duel.findUnique({ where: { id } });
    if (!duel) return res.status(404).json({ success: false, message: "Duel not found." });
    // Either side can back out of a PENDING duel.
    if (duel.opponentId !== userId && duel.challengerId !== userId) {
      return res.status(403).json({ success: false, message: "Not your duel." });
    }
    if (duel.status !== "PENDING") return res.status(410).json({ success: false, message: "This challenge is no longer open." });

    await prisma.$transaction(async (tx) => {
      const claim = await tx.duel.updateMany({ where: { id, status: "PENDING" }, data: { status: "DECLINED", finishedAt: new Date() } });
      if (claim.count === 0) return; // someone already resolved it
      await tx.user.update({ where: { id: duel.challengerId }, data: { arisePoints: { increment: duel.stake } } });
      await tx.pointLog.create({ data: { userId: duel.challengerId, amount: duel.stake, reason: `duel-refund:${id}` } });
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/duels/:id/forfeit  { userId } — walk out of a running duel.
export const forfeitDuel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req.body || {}) as { userId?: string };
    if (!guard(req, res, userId)) return;
    const id = req.params.id as string;

    const duel = await prisma.duel.findUnique({ where: { id } });
    if (!duel) return res.status(404).json({ success: false, message: "Duel not found." });
    if (duel.challengerId !== userId && duel.opponentId !== userId) {
      return res.status(403).json({ success: false, message: "Not your duel." });
    }
    if (duel.status !== "ACTIVE") {
      return res.status(410).json({ success: false, message: "That duel isn't running." });
    }

    const iAmChallenger = duel.challengerId === userId;
    const winnerId = iAmChallenger ? duel.opponentId : duel.challengerId;
    const winnerName = iAmChallenger ? duel.opponentName : duel.challengerName;
    const loserName = iAmChallenger ? duel.challengerName : duel.opponentName;
    const { toWinner, rake } = payout(duel.stake);
    const fine = forfeitFine(duel.stake);

    try {
      const out = await prisma.$transaction(async (tx) => {
        // Claim the duel FIRST. If the other player's winning move landed a
        // moment ago this fails, and nobody gets fined for a duel that had
        // already ended.
        const claim = await tx.duel.updateMany({
          where: { id, status: "ACTIVE" },
          data: { status: "FINISHED", winnerId, turnUserId: null, finishedAt: new Date() },
        });
        if (claim.count === 0) throw new DuelError(409, "That duel already ended.");

        // The pot settles exactly as it would on a normal win.
        await tx.user.update({ where: { id: winnerId }, data: { arisePoints: { increment: toWinner } } });
        await tx.pointLog.create({ data: { userId: winnerId, amount: toWinner, reason: `duel-forfeit-win:${id}` } });

        // The fine on top, clamped to what the quitter actually holds — a
        // forfeit must never push someone's balance negative.
        const quitter = await tx.user.findUnique({ where: { id: userId }, select: { arisePoints: true } });
        const charged = Math.max(0, Math.min(fine, quitter?.arisePoints ?? 0));
        if (charged > 0) {
          await tx.user.update({ where: { id: userId }, data: { arisePoints: { decrement: charged } } });
          await tx.pointLog.create({ data: { userId: userId!, amount: -charged, reason: `duel-forfeit-fine:${id}` } });
          await tx.user.update({ where: { id: winnerId }, data: { arisePoints: { increment: charged } } });
          await tx.pointLog.create({ data: { userId: winnerId, amount: charged, reason: `duel-forfeit-fine:${id}` } });
        }

        // A forfeit is a loss on the ladder — otherwise quitting would be a way
        // to protect a rating.
        const [wr, lr] = await Promise.all([
          tx.duelRating.upsert({ where: { userId: winnerId }, create: { userId: winnerId, username: winnerName }, update: {} }),
          tx.duelRating.upsert({ where: { userId: userId! }, create: { userId: userId!, username: loserName }, update: {} }),
        ]);
        await tx.duelRating.update({
          where: { userId: winnerId },
          data: { rating: { increment: eloDelta(wr.rating, lr.rating, true) }, wins: { increment: 1 }, streak: { increment: 1 }, username: winnerName },
        });
        await tx.duelRating.update({
          where: { userId: userId! },
          data: { rating: { increment: eloDelta(lr.rating, wr.rating, false) }, losses: { increment: 1 }, streak: 0, username: loserName },
        });

        await tx.notification.create({
          data: {
            userId: winnerId, actorId: userId!, type: "duel",
            message: `🏳️ ${loserName} forfeited your duel. You take ${(toWinner + charged).toLocaleString()} AP — ${toWinner.toLocaleString()} from the pot plus a ${charged.toLocaleString()} AP fine (${rake.toLocaleString()} burned by the house).`,
            link: "/duels",
          },
        });

        return { duel: await tx.duel.findUnique({ where: { id } }), charged };
      });
      res.json({ success: true, data: out.duel, fine: out.charged });
    } catch (e) {
      if (e instanceof DuelError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/duels/:id/move  { userId, action: "attack" | "heal" | "shield" | "focus" }
export const makeMove = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, action, index, cardId, target } = (req.body || {}) as {
      userId?: string; action?: string; index?: number; cardId?: string; target?: number;
    };
    if (!guard(req, res, userId)) return;
    const id = req.params.id as string;

    const duel = await prisma.duel.findUnique({ where: { id } });
    if (!duel) return res.status(404).json({ success: false, message: "Duel not found." });
    if (duel.status !== "ACTIVE" || !duel.state) return res.status(410).json({ success: false, message: "This duel isn't active." });
    if (duel.turnUserId !== userId) return res.status(409).json({ success: false, message: "It's not your turn." });

    const parsed: DuelState = JSON.parse(duel.state);
    if (!sideOf(parsed, userId!)) return res.status(403).json({ success: false, message: "You're not in this duel." });

    let act:
      | { type: "deploy"; index: number }
      | { type: "attack"; index?: number }
      | { type: "item"; item: ItemId }
      | { type: "support"; cardId: string; target?: number }
      | { type: "ability" };

    if (action === "deploy") {
      if (!Number.isInteger(index)) {
        return res.status(400).json({ success: false, message: "Which card do you want to send in?" });
      }
      act = { type: "deploy", index: Number(index) };
    } else if (action === "attack") {
      act = { type: "attack", index: Number.isInteger(index) ? Number(index) : undefined };
    } else if (action === "support") {
      const def = cardId ? CARDS[cardId] : undefined;
      if (!def?.support) return res.status(400).json({ success: false, message: "That isn't a support card." });
      // You must OWN the card to play it. Ownership is the only gate — the
      // card is never consumed, so nothing is deducted here; the engine
      // enforces once-per-duel.
      const owned = await prisma.userCard.findUnique({
        where: { userId_cardId: { userId: userId!, cardId: cardId! } },
        select: { cardId: true },
      });
      if (!owned) return res.status(403).json({ success: false, message: `You don't own ${def.name}.` });
      act = {
        type: "support",
        cardId: cardId!,
        // Which of YOUR fighters the card was dropped on. Only heal/revive
        // read it; the engine clamps an out-of-range value on its own.
        target: Number.isInteger(target) ? Number(target) : undefined,
      };
    } else if (action === "ability") {
      // No payload at all: WHICH ability fires is decided by whichever card is
      // on the field, which the engine already knows. Taking a cardId here
      // would let a hand-rolled request fire a card sitting on the bench.
      act = { type: "ability" };
    } else {
      const item = action as ItemId;
      if (!ITEMS[item]) return res.status(400).json({ success: false, message: "Unknown action." });
      act = { type: "item", item };
    }

    const result = applyAction(parsed, userId!, act, Math.random());

    // The engine hands back the ORIGINAL state object (not the clone) whenever
    // it refuses a move — card already played this duel, nothing wounded to
    // heal, nobody fallen to revive, no card deployed to attack with. Reference
    // equality is therefore an exact no-op detector. Without this the row gets
    // rewritten identically, the turn never passes, and the client is told the
    // move succeeded while visibly nothing happened.
    if (result.state === parsed) {
      const key = sideOf(parsed, userId!);
      const meSide = key === "a" ? parsed.a : parsed.b;
      const foeSide = key === "a" ? parsed.b : parsed.a;
      let why = "That move would have no effect right now.";
      if (act.type === "attack" && meSide.active < 0) {
        why = "Send a card in first.";
      } else if (act.type === "attack" && foeSide.active < 0) {
        why = `${foeSide.username} hasn't sent anyone in yet.`;
      } else if (act.type === "deploy") {
        why = "That card can't be sent in.";
      } else if (act.type === "support") {
        const used = meSide.usedSupports || [];
        why = used.length >= SUPPORTS_PER_DUEL
          ? `You've already played ${SUPPORTS_PER_DUEL} support cards this duel.`
          : used.includes(act.cardId)
          ? "You've already played that one this duel."
          : "That card wouldn't do anything right now.";
      }
      return res.status(400).json({ success: false, message: why });
    }

    // The move resolved — record the health point it produced. Done before
    // the serialize below so the write and the timeline can never disagree.
    recordTimeline(result.state);

    try {
      const out = await prisma.$transaction(async (tx) => {
        // Using an item spends a charge from the player's bag. Done INSIDE the
        // transaction and before the state write, so a failed move never eats
        // an item and a spent item is always reflected in the resulting state.
        if (act.type === "item") {
          const u = await tx.user.findUnique({ where: { id: userId }, select: { duelItems: true } });
          const bag = u?.duelItems || [];
          const at = bag.indexOf(act.item);
          if (at === -1) throw new DuelError(400, `You have no ${ITEMS[act.item].name} left.`);
          const next = [...bag];
          next.splice(at, 1);
          await tx.user.update({ where: { id: userId }, data: { duelItems: { set: next } } });
        }

        // Guarded on it still being this player's turn — two rapid submits
        // can't both resolve.
        const claim = await tx.duel.updateMany({
          where: { id, status: "ACTIVE", turnUserId: userId },
          data: {
            state: JSON.stringify(result.state),
            turnUserId: result.finished ? null : result.state.turn,
            ...(result.finished ? { status: "FINISHED", winnerId: result.winnerId, finishedAt: new Date() } : {}),
          },
        });
        if (claim.count === 0) throw new DuelError(409, "That move already went through.");

        if (result.finished && result.winnerId) {
          const loserId = result.winnerId === duel.challengerId ? duel.opponentId : duel.challengerId;

          // Cards that fell on the LOSING side go to sleep. Only the loser's:
          // hibernating every fallen card would put most of both collections
          // under after a single 5v5, which turns one bad match into an
          // evening of shard payments. Nothing is deleted — the row stays and
          // the card comes back with shards or another copy from a pack.
          const loserSide = result.state.a.userId === loserId ? result.state.a : result.state.b;
          const fallen = loserSide.fighters.filter((f) => f.hp <= 0).map((f) => f.cardId);
          if (fallen.length) {
            await tx.userCard.updateMany({
              where: { userId: loserId, cardId: { in: fallen } },
              data: { hibernating: true },
            });
          }

          const winnerName = result.winnerId === duel.challengerId ? duel.challengerName : duel.opponentName;
          const loserName = result.winnerId === duel.challengerId ? duel.opponentName : duel.challengerName;
          const { toWinner, rake } = payout(duel.stake);

          // Winner takes the pot minus the burned rake.
          await tx.user.update({ where: { id: result.winnerId }, data: { arisePoints: { increment: toWinner } } });
          await tx.pointLog.create({ data: { userId: result.winnerId, amount: toWinner, reason: `duel-win:${id}` } });

          // Elo, both sides.
          const [wr, lr] = await Promise.all([
            tx.duelRating.upsert({ where: { userId: result.winnerId }, create: { userId: result.winnerId, username: winnerName }, update: {} }),
            tx.duelRating.upsert({ where: { userId: loserId }, create: { userId: loserId, username: loserName }, update: {} }),
          ]);
          const dW = eloDelta(wr.rating, lr.rating, true);
          const dL = eloDelta(lr.rating, wr.rating, false);
          await tx.duelRating.update({
            where: { userId: result.winnerId },
            data: { rating: { increment: dW }, wins: { increment: 1 }, streak: { increment: 1 }, username: winnerName },
          });
          await tx.duelRating.update({
            where: { userId: loserId },
            data: { rating: { increment: dL }, losses: { increment: 1 }, streak: 0, username: loserName },
          });

          await tx.notification.create({
            data: {
              userId: loserId, actorId: result.winnerId, type: "duel",
              message: `⚔️ ${winnerName} won your duel. ${toWinner.toLocaleString()} AP taken (${rake.toLocaleString()} burned by the house).`,
              link: "/duels",
            },
          });
        }
        return tx.duel.findUnique({ where: { id } });
      });
      res.json({ success: true, data: out });
    } catch (e) {
      if (e instanceof DuelError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/duels/buy-item  { userId, item } — shards buy duel consumables.
// Stored as a per-user stock the duel draws from when it starts.
export const buyItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, item } = (req.body || {}) as { userId?: string; item?: ItemId };
    if (!guard(req, res, userId)) return;
    const def = item ? ITEMS[item] : undefined;
    if (!def) return res.status(400).json({ success: false, message: "Unknown item." });

    // The lead dev's shard spends are free — mirrors isLeadDevFree in
    // card.controller (the testing account, lead dev ONLY, role-column-first).
    const free = await isLeadDevFree(userId!);
    try {
      const shards = await prisma.$transaction(async (tx) => {
        if (!free) {
          const debit = await tx.user.updateMany({
            where: { id: userId, shards: { gte: def.shards } },
            data: { shards: { decrement: def.shards } },
          });
          if (debit.count === 0) throw new DuelError(402, `${def.name} costs ${def.shards} shards — you don't have enough.`);
        }
        const u = await tx.user.update({
          where: { id: userId },
          data: { duelItems: { push: def.id } },
          select: { shards: true, duelItems: true },
        });
        return u;
      });
      res.json({ success: true, data: shards });
    } catch (e) {
      if (e instanceof DuelError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

class DuelError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}
