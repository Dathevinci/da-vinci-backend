import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { requireStaff } from "../lib/staff";
import { SHOP_CATALOG, PURCHASED_FIELD } from "../data/shopCatalog";

/**
 * THE ARISE AUCTION HOUSE — a server-run points SINK.
 *
 * The house (Lead Dev) lists an item; users bid Arise Points; the highest bid
 * when the clock runs out wins. Bids are escrowed — deducted the moment you
 * bid, refunded the moment you're outbid — so at any time only the current
 * leader has points held. The winner's points are simply never refunded, which
 * is the whole point: they leave circulation for good.
 *
 * Two things this code has to get right because it moves money:
 *  1. BID is atomic under an optimistic guard on (topBid, topBidderId). Two
 *     bids landing together can't both "win" — the second sees the row already
 *     changed and is told to retry, so points are never double-refunded or a
 *     bid lost.
 *  2. SETTLEMENT is lazy and idempotent. Render's free tier sleeps, so there is
 *     no cron to close auctions — instead any read settles anything past its
 *     clock, guarded by `status: "ACTIVE"` so the grant runs exactly once even
 *     if two people load a finished auction at the same instant.
 */

const MIN_DURATION_H = 1;
const MAX_DURATION_H = 24 * 14; // two weeks
const ANTISNIPE_MS = 2 * 60 * 1000; // a bid in the last 2 min extends by 2 min
const RECENT_SETTLED_LIMIT = 12;

type AuctionRow = Awaited<ReturnType<typeof prisma.auction.findUnique>>;

// Settle one auction if its clock has run out. Idempotent: the status guard in
// the updateMany means only the first caller past the deadline does the work.
async function settleIfEnded(auction: NonNullable<AuctionRow>): Promise<void> {
  if (auction.status !== "ACTIVE" || auction.endsAt.getTime() > Date.now()) return;

  await prisma.$transaction(async (tx) => {
    // Claim the settlement. If another request already flipped it, count is 0
    // and we do nothing — the winner is granted the item exactly once.
    const claim = await tx.auction.updateMany({
      where: { id: auction.id, status: "ACTIVE" },
      data: { status: "SETTLED", settledAt: new Date(), winnerId: auction.topBidderId },
    });
    if (claim.count === 0) return;

    // No bids → nothing to grant. The winner's points were already taken at bid
    // time (the sink), so there is nothing to deduct here either.
    if (!auction.topBidderId) return;

    const item = SHOP_CATALOG[auction.itemId];
    if (!item) return; // item pulled from the catalog after listing — just close it
    const field = PURCHASED_FIELD[item.type];

    const winner = await tx.user.findUnique({ where: { id: auction.topBidderId } });
    if (!winner) return;
    const owned = ((winner as any)[field] as string[]) || [];
    if (!owned.includes(auction.itemId)) {
      await tx.user.update({
        where: { id: winner.id },
        data: { [field]: { push: auction.itemId } },
      });
    }

    await tx.notification.create({
      data: {
        userId: winner.id,
        actorId: winner.id,
        type: "auction",
        message: `🏆 You won "${auction.title}" at auction for ${auction.topBid.toLocaleString()} Arise Points! Open Shop → Owned to equip it.`,
        link: "/shop",
      },
    });
  });
}

// GET /api/auctions — active auctions (soonest-closing first) + recent results.
export const listAuctions = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Settle anything whose clock has run out before we read the list, so a
    // sleeping server doesn't leave finished auctions "live" forever.
    const ended = await prisma.auction.findMany({
      where: { status: "ACTIVE", endsAt: { lte: new Date() } },
    });
    for (const a of ended) await settleIfEnded(a);

    const [active, settled] = await Promise.all([
      prisma.auction.findMany({ where: { status: "ACTIVE" }, orderBy: { endsAt: "asc" } }),
      prisma.auction.findMany({
        where: { status: "SETTLED" },
        orderBy: { settledAt: "desc" },
        take: RECENT_SETTLED_LIMIT,
      }),
    ]);

    res.json({ success: true, data: { active, settled } });
  } catch (error) {
    next(error);
  }
};

// GET /api/auctions/:id — one auction, its recent bids, settled if it's due.
export const getAuction = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    let auction = await prisma.auction.findUnique({ where: { id } });
    if (!auction) return res.status(404).json({ success: false, message: "Auction not found." });

    if (auction.status === "ACTIVE" && auction.endsAt.getTime() <= Date.now()) {
      await settleIfEnded(auction);
      auction = await prisma.auction.findUnique({ where: { id } });
    }

    const bids = await prisma.auctionBid.findMany({
      where: { auctionId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    res.json({ success: true, data: { auction, bids } });
  } catch (error) {
    next(error);
  }
};

// POST /api/auctions — list an item for auction. LEAD DEV ONLY (hard-gated):
// creating auctions can hand out shop items, so this is the one operation that
// must never be forgeable.
export const createAuction = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return; // requireStaff already sent 401/403

    const { itemId, startPrice, durationHours, minIncrement } = (req.body || {}) as {
      itemId?: string;
      startPrice?: number;
      durationHours?: number;
      minIncrement?: number;
    };

    const item = itemId ? SHOP_CATALOG[itemId] : undefined;
    if (!item) return res.status(400).json({ success: false, message: "That item isn't in the catalog." });

    const start = Math.max(0, Math.floor(Number(startPrice) || 0));
    const inc = Math.max(1, Math.floor(Number(minIncrement) || 100));
    const hours = Number(durationHours);
    if (!(hours >= MIN_DURATION_H && hours <= MAX_DURATION_H)) {
      return res.status(400).json({ success: false, message: `Duration must be ${MIN_DURATION_H}–${MAX_DURATION_H} hours.` });
    }

    const endsAt = new Date(Date.now() + hours * 3600 * 1000);
    const auction = await prisma.auction.create({
      data: {
        itemId,
        itemType: item.type,
        // Snapshot a readable title; the catalog has no display names, so fall
        // back to the id if the client didn't send one.
        title: (req.body?.title as string)?.trim() || itemId!,
        startPrice: start,
        minIncrement: inc,
        endsAt,
      },
    });

    res.status(201).json({ success: true, data: auction });
  } catch (error) {
    next(error);
  }
};

// POST /api/auctions/:id/bid  body { userId, amount }
// Soft-gated (matches purchase/gift): a verified token wins, tokenless pre-JWT
// sessions are grandfathered. Bidding spends the bidder's OWN points only.
export const placeBid = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { userId, amount } = (req.body || {}) as { userId?: string; amount?: number };

    if (!userId || amount == null) {
      return res.status(400).json({ success: false, message: "Missing userId or amount." });
    }
    const actor = getActorId(req);
    if (actor && actor !== userId) {
      return res.status(403).json({ success: false, message: "You can only bid with your own Arise Points." });
    }
    const bid = Math.floor(Number(amount));
    if (!(bid > 0)) return res.status(400).json({ success: false, message: "Bid must be a positive number." });

    // Read current state, settle first if the clock already ran out (so a late
    // bid on a finished auction is rejected rather than silently accepted).
    let auction = await prisma.auction.findUnique({ where: { id } });
    if (!auction) return res.status(404).json({ success: false, message: "Auction not found." });
    if (auction.status === "ACTIVE" && auction.endsAt.getTime() <= Date.now()) {
      await settleIfEnded(auction);
      auction = await prisma.auction.findUnique({ where: { id } });
    }
    if (!auction || auction.status !== "ACTIVE") {
      return res.status(410).json({ success: false, message: "This auction has closed." });
    }

    if (auction.topBidderId === userId) {
      return res.status(409).json({ success: false, message: "You're already the top bidder." });
    }

    // Don't let someone win something they already own — they'd pay and get
    // nothing (the settlement grant is a no-op on an owned item).
    const item = SHOP_CATALOG[auction.itemId];
    if (!item) return res.status(410).json({ success: false, message: "This item is no longer available." });
    const field = PURCHASED_FIELD[item.type];

    const minBid = Math.max(auction.startPrice, auction.topBid > 0 ? auction.topBid + auction.minIncrement : auction.startPrice);
    if (bid < minBid) {
      return res.status(400).json({ success: false, message: `Bid at least ${minBid.toLocaleString()} Arise Points.` });
    }

    // Capture the state we validated against; the transaction only commits if
    // the row still looks exactly like this, so a bid that raced ahead of us
    // can't be clobbered.
    const prevTop = auction.topBid;
    const prevBidderId = auction.topBidderId;
    const prevEndsAt = auction.endsAt;

    // Anti-snipe: a bid inside the final window pushes the clock out, so the
    // auction ends on interest dying down, not on reflexes.
    const nextEndsAt =
      auction.endsAt.getTime() - Date.now() < ANTISNIPE_MS
        ? new Date(Date.now() + ANTISNIPE_MS)
        : auction.endsAt;

    try {
      await prisma.$transaction(async (tx) => {
        const bidder = await tx.user.findUnique({ where: { id: userId } });
        if (!bidder) throw new BidError(404, "User not found.");
        const owned = ((bidder as any)[field] as string[]) || [];
        if (owned.includes(auction!.itemId)) throw new BidError(409, "You already own this item.");
        if (bidder.arisePoints < bid) {
          throw new BidError(402, `You need ${bid.toLocaleString()} Arise Points — you have ${bidder.arisePoints.toLocaleString()}.`);
        }

        // Optimistic claim: only succeeds while the row is still what we read.
        const claim = await tx.auction.updateMany({
          where: { id: auction!.id, status: "ACTIVE", topBid: prevTop, topBidderId: prevBidderId, endsAt: prevEndsAt },
          data: {
            topBid: bid,
            topBidderId: userId,
            topBidderName: bidder.username,
            bidCount: { increment: 1 },
            endsAt: nextEndsAt,
          },
        });
        if (claim.count === 0) throw new BidError(409, "Someone bid at the same moment — try again.");

        // Refund the previous leader (logged so it can't be counted as a daily
        // content earn — economy.ts excludes reasons starting with "auction").
        if (prevBidderId && prevTop > 0) {
          await tx.user.update({ where: { id: prevBidderId }, data: { arisePoints: { increment: prevTop } } });
          await tx.pointLog.create({ data: { userId: prevBidderId, amount: prevTop, reason: `auction-refund:${auction!.id}` } });
        }

        // Escrow the new bid.
        await tx.user.update({ where: { id: userId }, data: { arisePoints: { decrement: bid } } });
        await tx.pointLog.create({ data: { userId, amount: -bid, reason: `auction-bid:${auction!.id}` } });
        await tx.auctionBid.create({ data: { auctionId: auction!.id, userId, username: bidder.username, amount: bid } });
      });
    } catch (e) {
      if (e instanceof BidError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }

    const fresh = await prisma.auction.findUnique({ where: { id } });
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { arisePoints: true } });
    res.json({ success: true, data: { auction: fresh, arisePoints: me?.arisePoints ?? 0 } });
  } catch (error) {
    next(error);
  }
};

// POST /api/auctions/:id/cancel — pull an auction. LEAD DEV ONLY. Refunds the
// current leader so nobody loses points to a cancellation.
export const cancelAuction = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const id = req.params.id as string;
    const auction = await prisma.auction.findUnique({ where: { id } });
    if (!auction) return res.status(404).json({ success: false, message: "Auction not found." });
    if (auction.status !== "ACTIVE") return res.status(410).json({ success: false, message: "Auction isn't active." });

    await prisma.$transaction(async (tx) => {
      const claim = await tx.auction.updateMany({
        where: { id, status: "ACTIVE" },
        data: { status: "CANCELLED", settledAt: new Date() },
      });
      if (claim.count === 0) return;
      if (auction.topBidderId && auction.topBid > 0) {
        await tx.user.update({ where: { id: auction.topBidderId }, data: { arisePoints: { increment: auction.topBid } } });
        await tx.pointLog.create({ data: { userId: auction.topBidderId, amount: auction.topBid, reason: `auction-refund:${auction.id}` } });
      }
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// Small typed carrier so a validation failure inside the bid transaction rolls
// it back AND surfaces the right HTTP status, instead of a generic 500.
class BidError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}
