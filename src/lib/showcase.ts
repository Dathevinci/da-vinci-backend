import { prisma } from "./prisma";

/**
 * WHAT "STILL YOURS" MEANS, in one place.
 *
 * The showcase is a plain `String[]` of card ids on the user row, validated
 * only when it is written. Every path that takes a card away from you —
 * synthesising five legendaries into a Mythic, dusting, selling — leaves the
 * id sitting in that array. The profile then resolves it against the card
 * CATALOG (which of course still has it) and renders a card you no longer
 * own, forever.
 *
 * That alone would only be cosmetic. The trap is that setShowcase rejects the
 * WHOLE array if any id fails the ownership check, so one burned card means
 * you can never save a showcase change again — and the picker only lists
 * cards you own, so the offending card isn't there to untick. Locked out by
 * a card that no longer exists.
 *
 * Filtering here, at read time, heals every already-broken profile on the
 * next load with no migration, and covers every future removal path without
 * anyone having to remember to prune.
 *
 * ESCROW IS THE SUBTLE PART. Listing a card on the market DELETES the
 * UserCard row and holds the card in the listing, and cancelling gives it
 * back. So ownership is not "has a UserCard row" — a naive filter would blank
 * your pinned card the moment you listed it, which is a worse bug than the
 * one being fixed. The truth is the union with your own ACTIVE listings.
 */

/** Card ids from `ids` that are genuinely still the user's — held or escrowed. */
export async function heldCardIds(userId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set<string>();

  // Both scoped by `in: ids`, so this never degrades into a full scan of a
  // big collection. Indexed by @@index([userId]) and @@index([sellerId, status]).
  const [owned, listed] = await Promise.all([
    prisma.userCard.findMany({
      where: { userId, cardId: { in: ids } },
      select: { cardId: true },
    }),
    prisma.cardListing.findMany({
      where: { sellerId: userId, status: "ACTIVE", cardId: { in: ids } },
      select: { cardId: true },
    }),
  ]);

  const held = new Set<string>();
  for (const row of owned) held.add(row.cardId);
  for (const row of listed) held.add(row.cardId);
  return held;
}

/**
 * The showcase as it should actually render — pinned order preserved, entries
 * you no longer own dropped. Returns fast without querying for the many users
 * who have pinned nothing.
 */
export async function liveShowcase(
  userId: string,
  ids: string[] | null | undefined
): Promise<string[]> {
  if (!ids || ids.length === 0) return [];
  const held = await heldCardIds(userId, ids);
  return ids.filter((id) => held.has(id));
}
