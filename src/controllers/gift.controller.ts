import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getRole } from "../utils/economy";
import { SHOP_CATALOG, PURCHASED_FIELD, isAvailable } from "../data/shopCatalog";
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

    // Lead Dev has infinite Arise Points, so their gifts are free (mirrors the shop).
    const cost = getRole(gifter.username) === "LEAD_DEV" ? 0 : item.price;
    if (gifter.arisePoints < cost) {
      return res.status(402).json({
        success: false,
        message: `You need ${item.price.toLocaleString()} Arise Points to gift this — you have ${gifter.arisePoints.toLocaleString()}.`,
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

    const item = SHOP_CATALOG[itemId];
    if (!item) {
      return res.status(400).json({ success: false, message: "That item isn't for sale." });
    }
    const field = PURCHASED_FIELD[item.type];

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
    const cost = staff ? 0 : item.price;

    if (user.arisePoints < cost) {
      return res.status(402).json({
        success: false,
        message: `You need ${item.price.toLocaleString()} Arise Points — you have ${user.arisePoints.toLocaleString()}.`,
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
