import { prisma } from "./prisma";
import { CARDS } from "../data/cardCatalog";
import { rollCondition } from "./prints";

/**
 * ONE-TIME BACKFILL, safe to run on every boot.
 *
 * Prints arrived after legendaries already existed in the world, so every
 * copy owned before the feature shipped has no identity. This walks all
 * legendary cards and mints the shortfall (copies minus prints) per holder —
 * conditions rolled at the normal odds, serials in user-row order, so the
 * earliest collectors get the low numbers, which is the right kind of unfair.
 *
 * Idempotent by construction: it mints only max(0, copies - prints), so a
 * second run finds no shortfall and writes nothing.
 *
 * SHAPE MATTERS HERE, twice over:
 * - Everything for a card — the reads AND the mint — happens inside ONE
 *   transaction. Reading outside it was a real hole: this runs after
 *   listen(), with live traffic (and, during a deploy, the OLD instance)
 *   dusting and listing while it walks, and a stale shortfall minted prints
 *   for copies that no longer existed.
 * - The inserts are one createMany, not a create per print. A widely-held
 *   legendary is hundreds of rows; at one round trip each that blows the
 *   interactive-transaction timeout, rolls back, and re-fails identically on
 *   every boot after.
 */
export async function backfillLegendaryPrints(): Promise<void> {
  try {
    const legendaryIds = Object.values(CARDS)
      .filter((c) => c.rarity === "legendary")
      .map((c) => c.id);

    let minted = 0;

    for (const cardId of legendaryIds) {
      minted += await prisma.$transaction(async (tx) => {
        // Copies held per user, oldest rows first so serial order rewards
        // whoever was here first.
        const rows = await tx.userCard.findMany({
          where: { cardId, count: { gt: 0 } },
          select: { userId: true, count: true },
          orderBy: { createdAt: "asc" },
        });
        // Copies escrowed in ACTIVE listings — they exist too.
        const listings = await tx.cardListing.findMany({
          where: { cardId, status: "ACTIVE" },
          select: { id: true, qty: true },
          orderBy: { createdAt: "asc" },
        });
        const heldPrints = await tx.cardPrint.groupBy({
          by: ["userId", "listingId"],
          where: { cardId },
          _count: { _all: true },
        });
        const printCount = (userId: string | null, listingId: string | null) =>
          heldPrints.find((p) => p.userId === userId && p.listingId === listingId)?._count._all ?? 0;

        const owed: { userId: string | null; listingId: string | null; n: number }[] = [];
        for (const r of rows) {
          const missing = r.count - printCount(r.userId, null);
          if (missing > 0) owed.push({ userId: r.userId, listingId: null, n: missing });
        }
        for (const l of listings) {
          const missing = l.qty - printCount(null, l.id);
          if (missing > 0) owed.push({ userId: null, listingId: l.id, n: missing });
        }
        if (!owed.length) return 0;

        const total = owed.reduce((s, o) => s + o.n, 0);
        const counter = await tx.printCounter.upsert({
          where: { cardId },
          create: { cardId, next: total + 1 },
          update: { next: { increment: total } },
          select: { next: true },
        });
        let serial = counter.next - total;
        const data: {
          cardId: string; serial: number; condition: string;
          userId: string | null; listingId: string | null;
        }[] = [];
        for (const o of owed) {
          for (let i = 0; i < o.n; i++) {
            data.push({
              cardId,
              serial: serial++,
              condition: rollCondition(),
              userId: o.userId,
              listingId: o.listingId,
            });
          }
        }
        await tx.cardPrint.createMany({ data });
        return data.length;
      }, { timeout: 20000 });
    }

    if (minted > 0) console.log(`🖨️  Print backfill minted ${minted} legendary prints.`);
  } catch (e) {
    console.error("Print backfill failed (API unaffected):", e);
  }
}
