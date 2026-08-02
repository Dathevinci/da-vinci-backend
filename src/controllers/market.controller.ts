import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { CARDS } from "../data/cardCatalog";

/**
 * CARD MARKETPLACE — player-to-player sales, server-escrowed.
 *
 * THE ESCROW RULE, which everything else here depends on:
 *
 *   Copies leave the seller's collection when the listing is CREATED, not when
 *   it sells. The listing row IS the custody record.
 *
 * Escrowing at sale time instead would let a seller list two copies and then
 * dust, foil or duel with them before a buyer arrived — and the sale would
 * later hand over cards that no longer existed, minting them out of nothing.
 * Every currency and item move below is a conditional updateMany inside a
 * transaction, so the check and the write are one atomic operation and two
 * simultaneous buyers cannot both win the same lot.
 *
 * Prices are whole Arise Points for the WHOLE lot, not per card.
 */

const MIN_PRICE = 10;
const MAX_PRICE = 1_000_000;
/** Burned on every sale. A market with no sink is an inflation pump. */
const MARKET_FEE_PERCENT = 5;

export function marketFee(price: number) {
  const fee = Math.floor((price * MARKET_FEE_PERCENT) / 100);
  return { fee, toSeller: price - fee };
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

class MarketError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

// ── GET /api/market ────────────────────────────────────────────────────────
// Open listings. `mine=<userId>` returns that seller's own, whatever status.
export const listListings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mine = req.query.mine as string | undefined;
    const cardId = req.query.cardId as string | undefined;
    const sort = (req.query.sort as string) || "low";

    const where: any = mine ? { sellerId: mine } : { status: "ACTIVE" };
    if (cardId) where.cardId = cardId;

    const rows = await prisma.cardListing.findMany({
      where,
      orderBy:
        sort === "high" ? { price: "desc" }
        : sort === "new" ? { createdAt: "desc" }
        : { price: "asc" },
      take: 120,
    });

    // The card definition travels with the listing so the client never has to
    // guess at a name or rarity it might not have loaded yet.
    res.json({
      success: true,
      data: rows.map((l) => ({ ...l, card: CARDS[l.cardId] ?? null })),
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/market  { userId, cardId, qty, price } ───────────────────────
export const createListing = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId, qty, price } = (req.body || {}) as {
      userId?: string; cardId?: string; qty?: number; price?: number;
    };
    if (!guard(req, res, userId)) return;

    const def = cardId ? CARDS[cardId] : undefined;
    if (!def) return res.status(404).json({ success: false, message: "No such card." });

    const amount = Math.floor(Number(qty) || 0);
    const ask = Math.floor(Number(price) || 0);
    if (amount < 1) return res.status(400).json({ success: false, message: "List at least one copy." });
    if (ask < MIN_PRICE || ask > MAX_PRICE) {
      return res.status(400).json({ success: false, message: `Price must be between ${MIN_PRICE} and ${MAX_PRICE.toLocaleString()} AP.` });
    }

    const row = await prisma.userCard.findUnique({
      where: { userId_cardId: { userId: userId!, cardId: cardId! } },
      select: { count: true, foil: true, level: true, hibernating: true },
    });
    if (!row || row.count < amount) {
      return res.status(400).json({ success: false, message: `You don't have ${amount} copies of ${def.name}.` });
    }
    if (row.hibernating) {
      return res.status(400).json({ success: false, message: `${def.name} is asleep. Wake it before selling.` });
    }

    const seller = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    if (!seller) return res.status(404).json({ success: false, message: "User not found." });

    try {
      const listing = await prisma.$transaction(async (tx) => {
        // Take the copies OUT of the collection, guarded on the count still
        // being there — two rapid submits can't escrow the same copies twice.
        const taken = await tx.userCard.updateMany({
          where: { userId, cardId, count: { gte: amount }, hibernating: false },
          data: { count: { decrement: amount } },
        });
        if (taken.count === 0) throw new MarketError(409, "Those copies are no longer available.");

        // A count of zero means the card has genuinely left the collection.
        // The row goes so the card stops showing in the binder at all.
        await tx.userCard.deleteMany({ where: { userId, cardId, count: { lte: 0 } } });

        return tx.cardListing.create({
          data: {
            sellerId: userId!,
            sellerName: seller.username,
            cardId: cardId!,
            qty: amount,
            foil: row.foil,
            level: row.level || 1,
            price: ask,
          },
        });
      });

      res.status(201).json({ success: true, data: { ...listing, card: def } });
    } catch (e) {
      if (e instanceof MarketError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// ── POST /api/market/:id/buy  { userId } ───────────────────────────────────
export const buyListing = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req.body || {}) as { userId?: string };
    if (!guard(req, res, userId)) return;
    const id = req.params.id as string;

    const listing = await prisma.cardListing.findUnique({ where: { id } });
    if (!listing) return res.status(404).json({ success: false, message: "Listing not found." });
    if (listing.status !== "ACTIVE") return res.status(410).json({ success: false, message: "That listing is gone." });
    if (listing.sellerId === userId) {
      return res.status(400).json({ success: false, message: "You can't buy your own listing." });
    }

    const buyer = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    if (!buyer) return res.status(404).json({ success: false, message: "User not found." });

    const def = CARDS[listing.cardId];
    const { fee, toSeller } = marketFee(listing.price);

    try {
      const out = await prisma.$transaction(async (tx) => {
        // Claim the listing FIRST. Whoever flips it from ACTIVE owns the sale,
        // so two simultaneous buyers can't both pay for one lot.
        const claim = await tx.cardListing.updateMany({
          where: { id, status: "ACTIVE" },
          data: {
            status: "SOLD",
            buyerId: userId!,
            buyerName: buyer.username,
            soldAt: new Date(),
          },
        });
        if (claim.count === 0) throw new MarketError(409, "Someone just bought that.");

        // Conditional debit: the affordability check and the spend are one op.
        const paid = await tx.user.updateMany({
          where: { id: userId, arisePoints: { gte: listing.price } },
          data: { arisePoints: { decrement: listing.price } },
        });
        if (paid.count === 0) {
          throw new MarketError(402, `You need ${listing.price.toLocaleString()} Arise Points for that.`);
        }
        await tx.pointLog.create({ data: { userId: userId!, amount: -listing.price, reason: `market-buy:${id}` } });

        // Seller is paid the price minus the burned fee.
        await tx.user.update({ where: { id: listing.sellerId }, data: { arisePoints: { increment: toSeller } } });
        await tx.pointLog.create({ data: { userId: listing.sellerId, amount: toSeller, reason: `market-sell:${id}` } });

        /**
         * The cards land in the buyer's collection.
         *
         * Foil and level come from the LISTING, not from any row the buyer
         * already has — they bought these specific copies. If the buyer
         * already owns the card, the counts merge and their existing row keeps
         * its own foil/level, because you cannot hold two different versions
         * of one card under this schema. That is a deliberate limitation and
         * the listing states the level being sold.
         */
        const existing = await tx.userCard.findUnique({
          where: { userId_cardId: { userId: userId!, cardId: listing.cardId } },
          select: { id: true },
        });
        if (existing) {
          await tx.userCard.update({
            where: { userId_cardId: { userId: userId!, cardId: listing.cardId } },
            data: { count: { increment: listing.qty }, hibernating: false },
          });
        } else {
          await tx.userCard.create({
            data: {
              userId: userId!,
              cardId: listing.cardId,
              count: listing.qty,
              foil: listing.foil,
              level: listing.level,
            },
          });
        }

        await tx.notification.create({
          data: {
            userId: listing.sellerId,
            actorId: userId!,
            type: "market",
            message: `💰 ${buyer.username} bought your ${def?.name || "card"} ×${listing.qty} for ${listing.price.toLocaleString()} AP (${fee.toLocaleString()} burned as fee).`,
            link: "/marketplace",
          },
        });

        const me = await tx.user.findUnique({ where: { id: userId }, select: { arisePoints: true } });
        return { arisePoints: me?.arisePoints ?? 0 };
      });

      res.json({ success: true, data: { ...out, cardId: listing.cardId, qty: listing.qty, fee } });
    } catch (e) {
      if (e instanceof MarketError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// ── POST /api/market/:id/cancel  { userId } ────────────────────────────────
// Pull a listing and take the escrowed copies back.
export const cancelListing = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req.body || {}) as { userId?: string };
    if (!guard(req, res, userId)) return;
    const id = req.params.id as string;

    const listing = await prisma.cardListing.findUnique({ where: { id } });
    if (!listing) return res.status(404).json({ success: false, message: "Listing not found." });
    if (listing.sellerId !== userId) {
      return res.status(403).json({ success: false, message: "That isn't your listing." });
    }
    if (listing.status !== "ACTIVE") {
      return res.status(410).json({ success: false, message: "That listing already closed." });
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Claim first, so a cancel racing a buy can only win if the buy hasn't.
        const claim = await tx.cardListing.updateMany({
          where: { id, status: "ACTIVE" },
          data: { status: "CANCELLED" },
        });
        if (claim.count === 0) throw new MarketError(409, "Too late — that just sold.");

        // Copies go home, with their foil and level intact.
        const existing = await tx.userCard.findUnique({
          where: { userId_cardId: { userId: userId!, cardId: listing.cardId } },
          select: { id: true },
        });
        if (existing) {
          await tx.userCard.update({
            where: { userId_cardId: { userId: userId!, cardId: listing.cardId } },
            data: { count: { increment: listing.qty } },
          });
        } else {
          await tx.userCard.create({
            data: {
              userId: userId!,
              cardId: listing.cardId,
              count: listing.qty,
              foil: listing.foil,
              level: listing.level,
            },
          });
        }
      });
      res.json({ success: true });
    } catch (e) {
      if (e instanceof MarketError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};
