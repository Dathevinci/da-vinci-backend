import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getRole } from "../utils/economy";
import {
  SHOP_CATALOG,
  PURCHASED_FIELD,
  isAvailable,
  priceOf,
  SHOP_BUNDLES,
  BUNDLE_DISCOUNT,
  type CatalogEntry,
} from "../data/shopCatalog";
import { ARENA_EFFECTS } from "../data/arenaEffects";
import { getActorId } from "../lib/jwt";

/**
 * Gift a shop item to another user, paid for with the gifter's own Arise Points.
 *
 * Server-authoritative: the price and inventory slot come from the backend
 * catalog (never the client), the gifter's balance is checked against the DB,
 * and the whole transfer (deduct gifter -> grant recipient -> log -> notify)
 * runs in one atomic transaction so it can't half-apply.
 *
 * POST /api/users/gift
 * body: { gifterId, recipientUsername, itemId }
 */
export const giftItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { gifterId, recipientUsername, itemId } = req.body as {
      gifterId?: string;
      recipientUsername?: string;
      itemId?: string;
    };

    if (!gifterId || !recipientUsername || !itemId) {
      return res.status(400).json({ success: false, message: "Missing gifterId, recipientUsername, or itemId." });
    }

    // You can only spend your OWN points (verified token wins; tokenless
    // pre-JWT sessions grandfathered).
    const actor = getActorId(req);
    if (actor && actor !== gifterId) {
      return res.status(403).json({ success: false, message: "You can only gift with your own Arise Points." });
    }

    const item = SHOP_CATALOG[itemId];
    if (!item) {
      return res.status(400).json({ success: false, message: "That item can't be gifted." });
    }
    // Limited-time drops: once the window closes, gifting is off too — the
    // countdown would be meaningless if the gift endpoint stayed open.
    if (!isAvailable(item)) {
      return res.status(410).json({ success: false, message: "That item's limited window has closed — it can no longer be gifted." });
    }
    const field = PURCHASED_FIELD[item.type];

    const gifter = await prisma.user.findUnique({ where: { id: gifterId } });
    if (!gifter) return res.status(404).json({ success: false, message: "Gifter not found." });

    const recipient = await prisma.user.findFirst({
      where: { username: { equals: recipientUsername.trim(), mode: "insensitive" } },
    });
    if (!recipient) return res.status(404).json({ success: false, message: `No user named "${recipientUsername}".` });

    if (recipient.id === gifter.id) {
      return res.status(400).json({ success: false, message: "You can't gift yourself — just buy it!" });
    }

    // Recipient already owns it?
    const owned = ((recipient as any)[field] as string[]) || [];
    if (owned.includes(itemId)) {
      return res.status(409).json({ success: false, message: `${recipient.username} already owns that.` });
    }

    // Lead Dev has infinite Arise Points, so their gifts are free (mirrors the
    // shop). Read the persistent role column first — this used to consult ONLY
    // getRole(username), so renaming would silently start charging them.
    const gifterRole = (gifter as any).role && (gifter as any).role !== "USER"
      ? (gifter as any).role
      : getRole(gifter.username);
    const cost = gifterRole === "LEAD_DEV" ? 0 : priceOf(item);
    if (gifter.arisePoints < cost) {
      return res.status(402).json({
        success: false,
        message: `You need ${priceOf(item).toLocaleString()} Arise Points to gift this — you have ${gifter.arisePoints.toLocaleString()}.`,
      });
    }

    // Atomic: deduct gifter, grant recipient, log, notify.
    const ops: any[] = [
      prisma.user.update({
        where: { id: gifter.id },
        data: cost > 0 ? { arisePoints: { decrement: cost } } : {},
      }),
      prisma.user.update({
        where: { id: recipient.id },
        data: { [field]: { push: itemId } },
      }),
      prisma.notification.create({
        data: {
          userId: recipient.id,
          actorId: gifter.id,
          type: "gift",
          message: `🎁 ${gifter.username} gifted you a shop item! Open Shop → Owned to equip it.`,
          link: "/shop",
        },
      }),
    ];
    if (cost > 0) {
      ops.push(
        prisma.pointLog.create({
          data: { userId: gifter.id, amount: -cost, reason: `Gifted "${itemId}" to ${recipient.username}` },
        })
      );
    }

    const [updatedGifter] = await prisma.$transaction(ops);

    res.json({ success: true, cost, arisePoints: (updatedGifter as any).arisePoints });
  } catch (error) {
    next(error);
  }
};

/**
 * Buy a whole themed collection at a discount.
 *
 * POST /api/users/purchase-bundle
 * body: { userId, bundleId }
 *
 * Server-authoritative in the same way purchaseItem is — the client sends only
 * the bundle id. The backend works out which members are still missing, prices
 * ONLY those, applies the discount, and grants them in one transaction.
 *
 * Charging for the full set regardless of ownership would be the obvious bug
 * here, so the remainder is computed from the DB inventory, never from anything
 * the client claims.
 */
export const purchaseBundle = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, bundleId } = req.body as { userId?: string; bundleId?: string };

    if (!userId || !bundleId) {
      return res.status(400).json({ success: false, message: "Missing userId or bundleId." });
    }

    // You can only buy for yourself (verified token wins; tokenless pre-JWT
    // sessions grandfathered, matching purchaseItem).
    const actor = getActorId(req);
    if (actor && actor !== userId) {
      return res.status(403).json({ success: false, message: "You can only buy with your own Arise Points." });
    }

    const bundle = SHOP_BUNDLES[bundleId];
    if (!bundle) return res.status(400).json({ success: false, message: "That bundle doesn't exist." });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    // Work out what's actually missing, skipping anything whose limited window
    // has closed — a bundle must not become a side door onto an expired drop.
    const missing: { id: string; item: CatalogEntry }[] = [];
    let expiredSkipped = 0;

    for (const id of bundle.items) {
      const item = SHOP_CATALOG[id];
      if (!item) continue;
      const owned = ((user as any)[PURCHASED_FIELD[item.type]] as string[]) || [];
      if (owned.includes(id)) continue;
      if (!isAvailable(item)) {
        expiredSkipped++;
        continue;
      }
      missing.push({ id, item });
    }

    if (missing.length === 0) {
      return res.status(409).json({
        success: false,
        message: expiredSkipped > 0
          ? "Everything still available in this collection is already yours."
          : "You already own this entire collection.",
      });
    }

    // Sum each item's CURRENT price (per-item sales included) so the bundle
    // discount stacks on the sale price rather than silently reverting it.
    const full = missing.reduce((sum, m) => sum + priceOf(m.item), 0);
    const role = (user as any).role && (user as any).role !== "USER" ? (user as any).role : getRole(user.username);
    const staff = role === "LEAD_DEV" || role === "ADMIN";
    const cost = staff ? 0 : Math.round(full * (1 - BUNDLE_DISCOUNT));

    if (user.arisePoints < cost) {
      return res.status(402).json({
        success: false,
        message: `You need ${cost.toLocaleString()} Arise Points for the rest of this collection — you have ${user.arisePoints.toLocaleString()}.`,
      });
    }

    // Group the pushes by inventory field so each field is written once.
    const byField: Record<string, string[]> = {};
    for (const m of missing) {
      const f = PURCHASED_FIELD[m.item.type];
      (byField[f] ||= []).push(m.id);
    }
    const data: any = {};
    for (const [f, ids] of Object.entries(byField)) data[f] = { push: ids };
    if (cost > 0) data.arisePoints = { decrement: cost };

    const ops: any[] = [prisma.user.update({ where: { id: user.id }, data })];
    if (cost > 0) {
      ops.push(
        prisma.pointLog.create({
          data: { userId: user.id, amount: -cost, reason: `Bought "${bundle.name}" (${missing.length} items)` },
        })
      );
    }

    const [updated] = await prisma.$transaction(ops);

    res.json({
      success: true,
      data: {
        bundleId,
        granted: missing.map((m) => m.id),
        cost,
        saved: staff ? 0 : full - cost,
        expiredSkipped,
        arisePoints: (updated as any).arisePoints,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Buy a shop item for YOURSELF with your own Arise Points. Server-authoritative:
 * price + inventory slot come from the backend catalog, the balance is checked
 * against the DB, and deduct+grant+log run atomically. This is what makes AP a
 * real currency — the client can no longer set its own balance or inventory.
 *
 * POST /api/users/purchase
 * body: { userId, itemId }
 */
export const purchaseItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, itemId } = req.body as { userId?: string; itemId?: string };

    if (!userId || !itemId) {
      return res.status(400).json({ success: false, message: "Missing userId or itemId." });
    }

    // You can only buy for yourself (verified token wins; tokenless pre-JWT
    // sessions grandfathered).
    const actor = getActorId(req);
    if (actor && actor !== userId) {
      return res.status(403).json({ success: false, message: "You can only buy with your own Arise Points." });
    }

    // Arena effects live in their own catalog and their own inventory column,
    // but the money, ownership and staff rules are identical — so they ride
    // the same endpoint rather than a parallel one that could drift from it.
    const arena = ARENA_EFFECTS[itemId];
    const item: CatalogEntry | undefined = arena
      ? { type: "effect", price: arena.price }
      : SHOP_CATALOG[itemId];
    if (!item) {
      return res.status(400).json({ success: false, message: "That item isn't for sale." });
    }
    const field = arena ? "purchasedArenaEffects" : PURCHASED_FIELD[item.type];

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    // Already owned → idempotent success (covers double-clicks / retries).
    // Deliberately checked BEFORE the limited-window wall so a retry of a
    // purchase that succeeded at 23:59:58 doesn't error at 00:00:01.
    const owned = ((user as any)[field] as string[]) || [];
    if (owned.includes(itemId)) {
      return res.json({ success: true, alreadyOwned: true, arisePoints: user.arisePoints });
    }

    // Limited-time drops: server-side wall, so the shop countdown can't be
    // bypassed by calling the endpoint directly after the window closes.
    if (!isAvailable(item)) {
      return res.status(410).json({ success: false, message: "This limited item is no longer available — its window has closed." });
    }

    // Staff (Lead Dev / Admin) buy free, mirroring the shop UI. Role is tied to
    // the account and self-heals from the username for un-backfilled accounts.
    const role = (user as any).role && (user as any).role !== "USER" ? (user as any).role : getRole(user.username);
    const staff = role === "LEAD_DEV" || role === "ADMIN";
    const cost = staff ? 0 : priceOf(item);

    if (user.arisePoints < cost) {
      return res.status(402).json({
        success: false,
        message: `You need ${priceOf(item).toLocaleString()} Arise Points — you have ${user.arisePoints.toLocaleString()}.`,
      });
    }

    const ops: any[] = [
      prisma.user.update({
        where: { id: user.id },
        data: {
          ...(cost > 0 && { arisePoints: { decrement: cost } }),
          [field]: { push: itemId },
        },
      }),
    ];
    if (cost > 0) {
      ops.push(
        prisma.pointLog.create({
          data: { userId: user.id, amount: -cost, reason: `Bought "${itemId}"` },
        })
      );
    }

    const [updated] = await prisma.$transaction(ops);

    res.json({ success: true, cost, arisePoints: (updated as any).arisePoints, itemId, type: item.type });
  } catch (error) {
    next(error);
  }
};
