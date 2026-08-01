import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import {
  CARDS,
  PACK_PRICE,
  PACK_SIZE,
  DUST_VALUE,
  CRAFT_COST,
  rollPack,
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
      },
    });
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
      prisma.userCard.findMany({ where: { userId }, select: { cardId: true, count: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { shards: true } }),
    ]);
    res.json({ success: true, data: { cards: owned, shards: user?.shards ?? 0 } });
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

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Atomic AP debit: check + deduct in one op. count 0 = couldn't afford.
        const debit = await tx.user.updateMany({
          where: { id: userId, arisePoints: { gte: PACK_PRICE } },
          data: { arisePoints: { decrement: PACK_PRICE } },
        });
        if (debit.count === 0) throw new CardError(402, `A pack costs ${PACK_PRICE.toLocaleString()} Arise Points — you don't have enough.`);
        await tx.pointLog.create({ data: { userId: userId!, amount: -PACK_PRICE, reason: "card-pack" } });

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

class CardError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}
