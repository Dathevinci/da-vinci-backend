import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { CARDS } from "../data/cardCatalog";
import {
  DECK_SIZE, ITEMS, ItemId, DuelState, makeSide, applyAction, sideOf,
  eloDelta, payout, MIN_STAKE, MAX_STAKE, DUEL_EXPIRY_HOURS,
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
    if (!Array.isArray(deck) || deck.length !== DECK_SIZE) {
      return res.status(400).json({ success: false, message: `Pick exactly ${DECK_SIZE} cards.` });
    }
    if (new Set(deck).size !== deck.length) {
      return res.status(400).json({ success: false, message: "Your deck must be three different cards." });
    }
    if (deck.some((id) => !CARDS[id])) {
      return res.status(400).json({ success: false, message: "Unknown card in deck." });
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
    const owned = await prisma.userCard.findMany({ where: { userId, cardId: { in: deck } }, select: { cardId: true } });
    if (owned.length !== deck.length) {
      return res.status(400).json({ success: false, message: "You don't own every card in that deck." });
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
    if (!Array.isArray(deck) || deck.length !== DECK_SIZE || new Set(deck).size !== deck.length || deck.some((c) => !CARDS[c])) {
      return res.status(400).json({ success: false, message: `Pick exactly ${DECK_SIZE} different cards you own.` });
    }

    const ownedRows = await prisma.userCard.findMany({
      where: { userId, cardId: { in: [...deck, ...duel.challengerDeck] } },
      select: { cardId: true, foil: true },
    });
    if (ownedRows.filter((r) => deck.includes(r.cardId)).length !== deck.length) {
      return res.status(400).json({ success: false, message: "You don't own every card in that deck." });
    }
    const challengerFoils = await prisma.userCard.findMany({
      where: { userId: duel.challengerId, cardId: { in: duel.challengerDeck }, foil: true },
      select: { cardId: true },
    });

    const stateObj: DuelState = {
      a: makeSide(duel.challengerId, duel.challengerName, duel.challengerDeck,
        new Set(challengerFoils.map((f) => f.cardId)), {}),
      b: makeSide(duel.opponentId, duel.opponentName, deck,
        new Set(ownedRows.filter((r) => r.foil).map((r) => r.cardId)), {}),
      turn: duel.challengerId, // challenger moves first
      log: [`${duel.opponentName} accepted the challenge.`],
      round: 1,
    };

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
          data: { status: "ACTIVE", opponentDeck: deck, state: JSON.stringify(stateObj), turnUserId: duel.challengerId },
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

// POST /api/duels/:id/move  { userId, action: "attack" | "heal" | "shield" | "focus" }
export const makeMove = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, action } = (req.body || {}) as { userId?: string; action?: string };
    if (!guard(req, res, userId)) return;
    const id = req.params.id as string;

    const duel = await prisma.duel.findUnique({ where: { id } });
    if (!duel) return res.status(404).json({ success: false, message: "Duel not found." });
    if (duel.status !== "ACTIVE" || !duel.state) return res.status(410).json({ success: false, message: "This duel isn't active." });
    if (duel.turnUserId !== userId) return res.status(409).json({ success: false, message: "It's not your turn." });

    const parsed: DuelState = JSON.parse(duel.state);
    if (!sideOf(parsed, userId!)) return res.status(403).json({ success: false, message: "You're not in this duel." });

    const act = action === "attack"
      ? { type: "attack" as const }
      : { type: "item" as const, item: action as ItemId };
    if (act.type === "item" && !ITEMS[act.item]) {
      return res.status(400).json({ success: false, message: "Unknown action." });
    }

    const result = applyAction(parsed, userId!, act, Math.random());

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

    try {
      const shards = await prisma.$transaction(async (tx) => {
        const debit = await tx.user.updateMany({
          where: { id: userId, shards: { gte: def.shards } },
          data: { shards: { decrement: def.shards } },
        });
        if (debit.count === 0) throw new DuelError(402, `${def.name} costs ${def.shards} shards — you don't have enough.`);
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
