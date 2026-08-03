import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { CARDS } from "../data/cardCatalog";
import { escrowPrints, escrowSerials, releasePrints, transferPrints } from "../lib/prints";
import { isLeadDevFree } from "./card.controller";

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
/**
 * Taken from every sale and paid to the lead dev as house revenue.
 *
 * Note this is NOT a sink — those points stay in circulation, they just change
 * hands. The duel rake and the shop still burn, so the economy keeps its
 * deflationary pressure elsewhere.
 */
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

/**
 * Who collects the market fee.
 *
 * Found by the ROLE COLUMN, never by username. Usernames are changeable here,
 * and keying revenue off a display name means the fee follows whoever happens
 * to hold that name rather than the actual account.
 *
 * Returns null if there is no lead dev, in which case the fee is simply burned
 * — better a missing payout than one sent to an arbitrary account.
 */
async function feeCollectorId(tx: any): Promise<string | null> {
  const lead = await tx.user.findFirst({
    where: { role: "LEAD_DEV" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return lead?.id ?? null;
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

    // Legendary listings carry the escrowed prints' identities — a Fresh
    // Build #3 is a different asset from a Factory New #212, and a buyer is
    // owed the difference before they pay for it.
    const prints = await prisma.cardPrint.findMany({
      where: { listingId: { in: rows.map((l) => l.id) } },
      select: { listingId: true, serial: true, condition: true },
      orderBy: { serial: "asc" },
    });
    const byListing: Record<string, { serial: number; condition: string }[]> = {};
    for (const p of prints) {
      if (p.listingId) (byListing[p.listingId] ||= []).push({ serial: p.serial, condition: p.condition });
    }

    // The card definition travels with the listing so the client never has to
    // guess at a name or rarity it might not have loaded yet.
    res.json({
      success: true,
      data: rows.map((l) => ({ ...l, card: CARDS[l.cardId] ?? null, prints: byListing[l.id] || undefined })),
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/market  { userId, cardId, qty, price } ───────────────────────
export const createListing = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId, qty, price, serials } = (req.body || {}) as {
      userId?: string; cardId?: string; qty?: number; price?: number; serials?: number[];
    };
    if (!guard(req, res, userId)) return;

    const def = cardId ? CARDS[cardId] : undefined;
    if (!def) return res.status(404).json({ success: false, message: "No such card." });

    // A legendary seller names EXACT serials — each wear tier is its own
    // asset, not a stack the server picks from. When serials are given they
    // ARE the quantity; qty is only trusted for tiers without prints.
    const chosen = def.rarity === "legendary" && Array.isArray(serials)
      ? [...new Set(serials.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 60)
      : [];
    const amount = chosen.length > 0 ? chosen.length : Math.floor(Number(qty) || 0);
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

    // ONE BUILD PER LISTING — each wear is its own market with its own
    // price. A lot mixing a Rusted with a Factory New would price them as
    // if they were the same thing. Condition never changes on a print, so
    // this pre-transaction read cannot be raced into a mixed lot.
    if (chosen.length > 1) {
      const picked = await prisma.cardPrint.findMany({
        where: { userId: userId!, cardId: cardId!, serial: { in: chosen } },
        select: { condition: true },
      });
      if (new Set(picked.map((p) => p.condition)).size > 1) {
        return res.status(400).json({
          success: false,
          message: "One build per listing — different wears are different cards. List each build separately.",
        });
      }
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

        const created = await tx.cardListing.create({
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
        // Legendary copies have identities. If the seller NAMED serials,
        // exactly those prints go up — a shortfall means someone raced them
        // (a concurrent list/attune took one), and the whole listing rolls
        // back rather than selling a different copy than the one they chose.
        // Without named serials (old clients), fall back to worst-first so a
        // partial listing never gives away the Fresh Build they meant to keep.
        if (CARDS[cardId!]?.rarity === "legendary") {
          if (chosen.length > 0) {
            const moved = await escrowSerials(tx, userId!, cardId!, created.id, chosen);
            if (moved !== chosen.length) {
              throw new MarketError(409, "Those exact prints just changed hands — refresh and pick again.");
            }
          } else {
            await escrowPrints(tx, userId!, cardId!, created.id, amount);
          }
        }
        return created;
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
    // Same bypass as every other sink: the lead dev never pays. The seller
    // is still paid in full below, so testing the market never shorts a
    // real player — the house simply eats the cost.
    const free = await isLeadDevFree(userId!);

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
        if (!free) {
          const paid = await tx.user.updateMany({
            where: { id: userId, arisePoints: { gte: listing.price } },
            data: { arisePoints: { decrement: listing.price } },
          });
          if (paid.count === 0) {
            throw new MarketError(402, `You need ${listing.price.toLocaleString()} Arise Points for that.`);
          }
          await tx.pointLog.create({ data: { userId: userId!, amount: -listing.price, reason: `market-buy:${id}` } });
        }

        // Seller is paid the price minus the house fee.
        await tx.user.update({ where: { id: listing.sellerId }, data: { arisePoints: { increment: toSeller } } });
        await tx.pointLog.create({ data: { userId: listing.sellerId, amount: toSeller, reason: `market-sell:${id}` } });

        // The fee goes to the lead dev. Skipped when the collector is the
        // seller or the buyer — paying yourself your own fee would let the
        // lead dev sell to themselves at no cost and log phantom revenue.
        const collector = await feeCollectorId(tx);
        if (fee > 0 && collector && collector !== listing.sellerId && collector !== userId) {
          await tx.user.update({ where: { id: collector }, data: { arisePoints: { increment: fee } } });
          await tx.pointLog.create({ data: { userId: collector, amount: fee, reason: `market-fee:${id}` } });
        }

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
        // The escrowed prints change hands with the copies — serial and
        // condition travel to the buyer, which is the entire point of them.
        await transferPrints(tx, listing.id, userId!);

        await tx.notification.create({
          data: {
            userId: listing.sellerId,
            actorId: userId!,
            type: "market",
            message: `💰 ${buyer.username} bought your ${def?.name || "card"} ×${listing.qty} for ${listing.price.toLocaleString()} AP. You received ${toSeller.toLocaleString()} after the ${fee.toLocaleString()} AP market fee.`,
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
        // Escrowed prints come home with the copies.
        await releasePrints(tx, listing.id, userId!);
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
