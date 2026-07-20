import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { apForAmount, kofiToken, SUPPORTER_MIN_AMOUNT, MEMBERSHIP_FALLBACK_AP } from "../data/kofiConfig";

// Pull possible Da Vinci usernames out of the Ko-fi note. Usernames are
// [a-zA-Z0-9_]{3,20} (see changeUsername), so we grab every such token and let
// the DB tell us which one is a real account.
function usernameCandidates(message?: string | null): string[] {
  if (!message) return [];
  const tokens = message.match(/[a-zA-Z0-9_]{3,20}/g) || [];
  return Array.from(new Set(tokens));
}

/**
 * Ko-fi webhook. Ko-fi POSTs application/x-www-form-urlencoded with a single
 * `data` field holding a JSON string. We verify the token, dedupe on the
 * transaction id, resolve the payer to a Da Vinci account via the note, grant
 * the Supporter badge + Arise Points SERVER-SIDE, and log the payment.
 */
export const kofiWebhook = async (req: Request, res: Response) => {
  try {
    const raw = req.body?.data;
    if (!raw) return res.status(400).json({ success: false, error: "Missing data" });

    let payload: any;
    try {
      payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return res.status(400).json({ success: false, error: "Bad JSON" });
    }

    const expected = kofiToken();
    if (!expected || payload.verification_token !== expected) {
      return res.status(401).json({ success: false, error: "Bad verification token" });
    }

    const kofiTxnId: string = payload.kofi_transaction_id || payload.message_id;
    if (!kofiTxnId) return res.status(400).json({ success: false, error: "Missing transaction id" });

    // Idempotency: Ko-fi can retry. If we've seen this txn, ack and stop.
    const existing = await prisma.donation.findUnique({ where: { kofiTxnId } });
    if (existing) return res.json({ success: true, duplicate: true });

    const type: string = payload.type || "Donation";
    const fromName: string = payload.from_name || "Anonymous";
    const message: string | null = payload.message ?? null;
    const currency: string = payload.currency || "GBP";
    const amount = parseFloat(payload.amount || "0") || 0;
    const isSubscription = !!payload.is_subscription_payment;
    const tierName: string | null = payload.tier_name ?? null;

    // Resolve the payer to a Da Vinci account from the note (one query).
    const candidates = usernameCandidates(message);
    let matched: { id: string; username: string; purchasedTags: string[] } | null = null;
    if (candidates.length) {
      matched = await prisma.user.findFirst({
        where: { OR: candidates.map((c) => ({ username: { equals: c, mode: "insensitive" as const } })) },
        select: { id: true, username: true, purchasedTags: true },
      });
    }

    // AP to grant. Any real amount uses the bundle logic; a membership with no
    // amount falls back to a flat perk.
    let ap = amount > 0 ? apForAmount(amount) : MEMBERSHIP_FALLBACK_AP;

    if (matched) {
      const needsTag = amount >= SUPPORTER_MIN_AMOUNT && !(matched.purchasedTags || []).includes("tag_supporter");
      await prisma.user.update({
        where: { id: matched.id },
        data: {
          ...(ap > 0 && { arisePoints: { increment: ap } }),
          ...(needsTag && { purchasedTags: { push: "tag_supporter" } }),
        },
      });
      if (ap > 0) {
        await prisma.pointLog.create({
          data: { userId: matched.id, amount: ap, reason: `Ko-fi ${type} (£${amount.toFixed(2)})` },
        });
      }
    } else {
      ap = 0; // nobody to credit
    }

    await prisma.donation.create({
      data: {
        kofiTxnId,
        type,
        fromName,
        amount,
        currency,
        message,
        tierName,
        isSubscription,
        isPublic: payload.is_public !== false,
        matchedUserId: matched?.id ?? null,
        matchedUsername: matched?.username ?? null,
        apGranted: ap,
      },
    });

    return res.json({ success: true, matched: !!matched, apGranted: ap });
  } catch (error) {
    console.error("Ko-fi webhook error:", error);
    // Still 200 so Ko-fi doesn't hammer retries on our bug; we've logged it.
    return res.status(200).json({ success: false });
  }
};

// Public, privacy-safe stats for the Support page: month-to-date total + a short
// recent-supporters feed. No emails, no raw notes.
export const kofiStats = async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const agg = await prisma.donation.aggregate({
      _sum: { amount: true },
      where: { createdAt: { gte: monthStart } },
    });

    const recentRows = await prisma.donation.findMany({
      where: { isPublic: true },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        fromName: true,
        matchedUsername: true,
        amount: true,
        currency: true,
        tierName: true,
        type: true,
        createdAt: true,
      },
    });

    const recent = recentRows.map((d) => ({
      name: d.matchedUsername || d.fromName,
      linked: !!d.matchedUsername,
      amount: d.amount,
      currency: d.currency,
      tierName: d.tierName,
      type: d.type,
      createdAt: d.createdAt,
    }));

    const currency = recentRows[0]?.currency || "GBP";
    return res.json({
      success: true,
      monthlyTotal: Math.round((agg._sum.amount || 0) * 100) / 100,
      currency,
      recent,
    });
  } catch (error) {
    console.error("Ko-fi stats error:", error);
    return res.status(500).json({ success: false, error: "Failed to load stats" });
  }
};
