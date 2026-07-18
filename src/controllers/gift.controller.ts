import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getRole } from "../utils/economy";
import { SHOP_CATALOG, PURCHASED_FIELD } from "../data/shopCatalog";

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

    const item = SHOP_CATALOG[itemId];
    if (!item) {
      return res.status(400).json({ success: false, message: "That item can't be gifted." });
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
