import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { getRole } from "../utils/economy";
import {
  CARDS,
  PACK_PRICE,
  PACK_SIZE,
  DUST_VALUE,
  CRAFT_COST,
  FOIL_COST,
  RELIC_PACK_SHARDS,
  SET_REWARDS,
  cardsInSet,
  rollPack,
  rollRelicPack,
} from "../data/cardCatalog";

/**
 * ARISE CARDS — collectible packs, dusting and crafting.
 *
 * The single AP touchpoint is opening a pack (the sink). Every currency debit
 * here — AP for a pack, shards for a craft — uses a CONDITIONAL updateMany
 * (`where balance >= cost`) so the balance check and the deduction are one
 * atomic DB op: a user firing two pack-opens at once can't spend the same
 * points twice. (Same lesson as the auction escrow.)
 *
 * Soft-gated like purchase/gift: a verified token must match the target;
 * tokenless pre-JWT sessions are grandfathered.
 */

// GET /api/cards/catalog — the whole set + economy constants, so the frontend
// has ONE source of truth for card data (no duplicated catalog to drift).
export const getCatalog = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: {
        cards: Object.values(CARDS),
        packPrice: PACK_PRICE,
        packSize: PACK_SIZE,
        dustValue: DUST_VALUE,
        craftCost: CRAFT_COST,
        foilCost: FOIL_COST,
        relicPackShards: RELIC_PACK_SHARDS,
        setRewards: SET_REWARDS,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Staff buy free everywhere else in the shop; cards match that. Reads the
// persistent role column first and self-heals from the username, so it survives
// a rename (see the identity rule).
async function isStaffFree(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, role: true } });
  if (!u) return false;
  const role = u.role && u.role !== "USER" ? u.role : getRole(u.username);
  return role === "LEAD_DEV" || role === "ADMIN";
}

// GET /api/cards/collectors — who owns what, ranked by completion. This is the
// "see other people's collections" board.
export const getCollectors = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const grouped = await prisma.userCard.groupBy({
      by: ["userId"],
      _count: { cardId: true },
      _sum: { count: true },
    });
    if (grouped.length === 0) return res.json({ success: true, data: [] });

    const users = await prisma.user.findMany({
      where: { id: { in: grouped.map((g) => g.userId) } },
      select: { id: true, username: true, avatar: true, cardTitle: true },
    });
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));

    const rows = grouped
      .filter((g) => byId[g.userId])
      .map((g) => ({
        userId: g.userId,
        username: byId[g.userId].username,
        avatar: byId[g.userId].avatar,
        cardTitle: byId[g.userId].cardTitle,
        distinct: g._count.cardId,
        total: g._sum.count || 0,
      }))
      .sort((a, b) => b.distinct - a.distinct || b.total - a.total)
      .slice(0, 50);

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
};

function ownerGuard(req: Request, res: Response, userId?: string): boolean {
  if (!userId) {
    res.status(400).json({ success: false, message: "Missing userId." });
    return false;
  }
  const actor = getActorId(req);
  if (actor && actor !== userId) {
    res.status(403).json({ success: false, message: "You can only manage your own collection." });
    return false;
  }
  return true;
}

// GET /api/cards/collection/:userId — owned cards (with counts) + shard balance.
// Public-ish: a collection is meant to be shown off, and it reveals nothing
// sensitive.
export const getCollection = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.userId as string;
    const [owned, user] = await Promise.all([
      prisma.userCard.findMany({ where: { userId }, select: { cardId: true, count: true, foil: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { shards: true, claimedSets: true, cardTitle: true } }),
    ]);
    res.json({
      success: true,
      data: {
        cards: owned,
        shards: user?.shards ?? 0,
        claimedSets: user?.claimedSets ?? [],
        cardTitle: user?.cardTitle ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/cards/open-pack  body { userId }
export const openPack = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req.body || {}) as { userId?: string };
    if (!ownerGuard(req, res, userId)) return;

    const pulls = rollPack(PACK_SIZE); // roll BEFORE the tx — pure, no I/O
    const free = await isStaffFree(userId!);

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Atomic AP debit: check + deduct in one op. count 0 = couldn't afford.
        if (!free) {
          const debit = await tx.user.updateMany({
            where: { id: userId, arisePoints: { gte: PACK_PRICE } },
            data: { arisePoints: { decrement: PACK_PRICE } },
          });
          if (debit.count === 0) throw new CardError(402, `A pack costs ${PACK_PRICE.toLocaleString()} Arise Points — you don't have enough.`);
          await tx.pointLog.create({ data: { userId: userId!, amount: -PACK_PRICE, reason: "card-pack" } });
        }

        // Grant each pull — upsert the per-card count so dupes stack.
        for (const cardId of pulls) {
          await tx.userCard.upsert({
            where: { userId_cardId: { userId: userId!, cardId } },
            create: { userId: userId!, cardId, count: 1 },
            update: { count: { increment: 1 } },
          });
        }

        const user = await tx.user.findUnique({ where: { id: userId }, select: { arisePoints: true } });
        return { arisePoints: user?.arisePoints ?? 0 };
      });

      res.json({ success: true, data: { pulls, arisePoints: result.arisePoints } });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/cards/dust  body { userId, cardId }
// Convert the DUPLICATE copies of one card (everything past the first) into
// shards. Keeps one copy so the card stays in your collection.
export const dustCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId } = (req.body || {}) as { userId?: string; cardId?: string };
    if (!ownerGuard(req, res, userId)) return;

    const card = cardId ? CARDS[cardId] : undefined;
    if (!card) return res.status(400).json({ success: false, message: "Unknown card." });
    if (card.rarity === "event") return res.status(400).json({ success: false, message: "Event cards can't be dusted." });

    try {
      const result = await prisma.$transaction(async (tx) => {
        const owned = await tx.userCard.findUnique({ where: { userId_cardId: { userId: userId!, cardId: cardId! } } });
        if (!owned || owned.count <= 1) throw new CardError(400, "You have no duplicates of that card.");

        const dupes = owned.count - 1;
        const gained = dupes * DUST_VALUE[card.rarity];
        // Collapse to a single copy, mint the shards.
        await tx.userCard.update({ where: { userId_cardId: { userId: userId!, cardId: cardId! } }, data: { count: 1 } });
        const user = await tx.user.update({ where: { id: userId }, data: { shards: { increment: gained } }, select: { shards: true } });
        return { gained, shards: user.shards };
      });
      res.json({ success: true, data: result });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/cards/craft  body { userId, cardId }
// Spend shards to add a specific card (turns bad luck into a guaranteed path).
export const craftCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId } = (req.body || {}) as { userId?: string; cardId?: string };
    if (!ownerGuard(req, res, userId)) return;

    const card = cardId ? CARDS[cardId] : undefined;
    if (!card) return res.status(400).json({ success: false, message: "Unknown card." });
    const cost = CRAFT_COST[card.rarity];
    if (!cost || card.rarity === "event") return res.status(400).json({ success: false, message: "That card can't be crafted." });

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Atomic shard debit — same conditional-updateMany guard as AP.
        const debit = await tx.user.updateMany({
          where: { id: userId, shards: { gte: cost } },
          data: { shards: { decrement: cost } },
        });
        if (debit.count === 0) throw new CardError(402, `Crafting ${card.name} costs ${cost.toLocaleString()} shards — you don't have enough.`);

        await tx.userCard.upsert({
          where: { userId_cardId: { userId: userId!, cardId: cardId! } },
          create: { userId: userId!, cardId: cardId!, count: 1 },
          update: { count: { increment: 1 } },
        });
        const user = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return { shards: user?.shards ?? 0 };
      });
      res.json({ success: true, data: { cardId, shards: result.shards } });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/cards/foil  body { userId, cardId }
// Spend shards to turn a card you own into its animated foil variant. Pure
// prestige — no gameplay edge, it just looks incredible.
export const foilCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId } = (req.body || {}) as { userId?: string; cardId?: string };
    if (!ownerGuard(req, res, userId)) return;

    const card = cardId ? CARDS[cardId] : undefined;
    if (!card) return res.status(400).json({ success: false, message: "Unknown card." });
    const cost = FOIL_COST[card.rarity];

    try {
      const result = await prisma.$transaction(async (tx) => {
        const owned = await tx.userCard.findUnique({ where: { userId_cardId: { userId: userId!, cardId: cardId! } } });
        if (!owned) throw new CardError(400, "You don't own that card.");
        if (owned.foil) throw new CardError(409, "That card is already foil.");

        const debit = await tx.user.updateMany({
          where: { id: userId, shards: { gte: cost } },
          data: { shards: { decrement: cost } },
        });
        if (debit.count === 0) throw new CardError(402, `Foiling ${card.name} costs ${cost.toLocaleString()} shards — you don't have enough.`);

        await tx.userCard.update({ where: { userId_cardId: { userId: userId!, cardId: cardId! } }, data: { foil: true } });
        const user = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return { shards: user?.shards ?? 0 };
      });
      res.json({ success: true, data: { cardId, foil: true, shards: result.shards } });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/cards/relic-pack  body { userId }
// A pack bought with SHARDS, guaranteed to contain at least one epic+. Lets a
// patient collector convert grinding into targeted luck.
export const openRelicPack = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req.body || {}) as { userId?: string };
    if (!ownerGuard(req, res, userId)) return;

    const pulls = rollRelicPack(PACK_SIZE);

    try {
      const result = await prisma.$transaction(async (tx) => {
        const debit = await tx.user.updateMany({
          where: { id: userId, shards: { gte: RELIC_PACK_SHARDS } },
          data: { shards: { decrement: RELIC_PACK_SHARDS } },
        });
        if (debit.count === 0) throw new CardError(402, `A relic pack costs ${RELIC_PACK_SHARDS.toLocaleString()} shards — you don't have enough.`);

        for (const cardId of pulls) {
          await tx.userCard.upsert({
            where: { userId_cardId: { userId: userId!, cardId } },
            create: { userId: userId!, cardId, count: 1 },
            update: { count: { increment: 1 } },
          });
        }
        const user = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return { shards: user?.shards ?? 0 };
      });
      res.json({ success: true, data: { pulls, shards: result.shards } });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/cards/claim-set  body { userId, set }
// Completing a set pays out ONCE: Arise Points, shards, and a permanent title.
// This is the point of collecting — the payoff you can wear.
export const claimSet = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, set } = (req.body || {}) as { userId?: string; set?: string };
    if (!ownerGuard(req, res, userId)) return;

    const reward = set ? SET_REWARDS[set] : undefined;
    if (!reward) return res.status(400).json({ success: false, message: "Unknown set." });

    const required = cardsInSet(set!);

    try {
      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { claimedSets: true } });
        if (!user) throw new CardError(404, "User not found.");
        if ((user.claimedSets || []).includes(set!)) throw new CardError(409, "You've already claimed this set's reward.");

        const owned = await tx.userCard.findMany({ where: { userId, cardId: { in: required } }, select: { cardId: true } });
        if (owned.length < required.length) {
          throw new CardError(400, `You need all ${required.length} cards in ${set} — you have ${owned.length}.`);
        }

        // Guard the claim on claimedSets NOT already containing the set, so a
        // double-submit can't pay twice.
        const claim = await tx.user.updateMany({
          where: { id: userId, NOT: { claimedSets: { has: set! } } },
          data: {
            claimedSets: { push: set! },
            arisePoints: { increment: reward.ap },
            shards: { increment: reward.shards },
            cardTitle: reward.title,
          },
        });
        if (claim.count === 0) throw new CardError(409, "You've already claimed this set's reward.");

        await tx.pointLog.create({ data: { userId: userId!, amount: reward.ap, reason: `card-set:${set}` } });
        const fresh = await tx.user.findUnique({ where: { id: userId }, select: { arisePoints: true, shards: true } });
        return { arisePoints: fresh?.arisePoints ?? 0, shards: fresh?.shards ?? 0, title: reward.title };
      });
      res.json({ success: true, data: result });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

class CardError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}
