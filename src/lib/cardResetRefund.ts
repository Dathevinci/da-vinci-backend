import { prisma } from "./prisma";
import { CARDS } from "../data/cardCatalog";

/**
 * CARD RESET REFUND — pays everyone out for the tiers about to be wiped.
 *
 * This MUST run and be verified BEFORE the catalogue wipe. Once those rows are
 * gone nothing reconstructs who held what: no ledger records per-card
 * ownership history, so a refund attempted afterwards has nothing to read.
 * That is why it ships in its own deploy.
 *
 * Idempotent through PointLog: a user who already has a `card-reset-refund`
 * entry is skipped entirely. Re-running is therefore a no-op, which matters
 * because this fires on every boot and Render restarts freely.
 *
 * Escrowed copies count. Listing a card MOVES the copies out of UserCard and
 * into the listing, so paying only on UserCard rows would quietly stiff every
 * seller with something on the market at the wrong moment.
 */

/** Owner-set values. Commons pay nothing on purpose: they are the bulk of
 *  every collection, and paying for them is what would flood the currency. */
const REFUND: Record<string, number> = {
  common: 0,
  rare: 50,
  legendary: 2000,
  mythic: 5000,
};

const REFUND_REASON = "card-reset-refund";

/** Rarities being wiped. `epic` and `event` survive and are never paid out. */
const WIPED = new Set(Object.keys(REFUND));

export async function refundWipedCards(): Promise<void> {
  try {
    // Which card ids are in scope, resolved from the catalogue while it still
    // HAS them. After the wipe this set would come back empty.
    const wipedIds = new Set(
      Object.values(CARDS).filter((c) => WIPED.has(c.rarity)).map((c) => c.id)
    );
    if (wipedIds.size === 0) {
      console.log("Card reset refund: catalogue already wiped — nothing to value. Skipping.");
      return;
    }

    const already = await prisma.pointLog.findMany({
      where: { reason: REFUND_REASON },
      select: { userId: true },
    });
    const paid = new Set(already.map((r) => r.userId));

    const ids = Array.from(wipedIds);
    const [held, escrowed] = await Promise.all([
      prisma.userCard.findMany({
        where: { cardId: { in: ids } },
        select: { userId: true, cardId: true, count: true },
      }),
      prisma.cardListing.findMany({
        where: { cardId: { in: ids }, status: "ACTIVE" },
        select: { sellerId: true, cardId: true, qty: true },
      }),
    ]);

    const owed = new Map<string, number>();
    const add = (userId: string, cardId: string, copies: number) => {
      const def = CARDS[cardId];
      if (!def) return;
      const each = REFUND[def.rarity] ?? 0;
      if (each <= 0) return;
      owed.set(userId, (owed.get(userId) || 0) + each * Math.max(1, copies));
    };

    for (const row of held) add(row.userId, row.cardId, row.count);
    for (const row of escrowed) add(row.sellerId, row.cardId, row.qty);

    let credited = 0;
    let totalAp = 0;

    for (const [userId, amount] of owed) {
      if (paid.has(userId) || amount <= 0) continue;
      try {
        // Points and their ledger line move together — a credit with no log
        // entry would be invisible AND would be paid again on the next boot.
        await prisma.$transaction([
          prisma.user.update({ where: { id: userId }, data: { arisePoints: { increment: amount } } }),
          prisma.pointLog.create({
            data: { userId, amount, reason: REFUND_REASON },
          }),
        ]);
        credited++;
        totalAp += amount;
      } catch (err) {
        // A deleted user, or any single failure, must not abort the sweep —
        // the rest still deserve paying.
        console.error(`Card reset refund: skipped ${userId}`, err);
      }
    }

    console.log(
      `Card reset refund: ${credited} user(s) credited, ${totalAp} AP total, ` +
      `${owed.size - credited} already paid or owed nothing.`
    );
  } catch (err) {
    console.error("Card reset refund failed:", err);
  }
}
