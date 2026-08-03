import { Prisma } from "@prisma/client";
import { CARDS } from "../data/cardCatalog";

/**
 * LEGENDARY PRINTS — per-copy identity for the rarest tier.
 *
 * Every legendary copy that enters the world gets a PRINT: a serial number
 * (global per card, in mint order — The Outer God #7 exists exactly once)
 * and a CONDITION rolled at mint. Three conditions, CS:GO-style:
 *
 *   Fresh Build  —  8%  · the chase within the chase
 *   Rusted       — 30%  · scarce, worn, storied
 *   Factory New  — 62%  · the standard issue
 *
 * Condition is cosmetic and market-facing ONLY. Nothing in duelRules reads
 * it — the same zero-combat-impact line the arena effects drew, and for the
 * same reason: scarcity should decide price, never fights.
 *
 * Serial assignment goes through PrintCounter, not max(serial)+1: a
 * unique-violation retry cannot work inside a Postgres transaction (the
 * constraint failure aborts the whole tx, taking the pack-open with it), so
 * the counter row's atomic increment under its row lock is the only shape
 * that survives two packs pulling the same card in the same instant.
 */

export const CONDITIONS = ["fresh", "rusted", "factory"] as const;
export type PrintCondition = (typeof CONDITIONS)[number];

export const CONDITION_META: Record<
  PrintCondition,
  { label: string; weight: number }
> = {
  fresh:   { label: "Fresh Build", weight: 8 },
  rusted:  { label: "Rusted",      weight: 30 },
  factory: { label: "Factory New", weight: 62 },
};

/** Sort value: higher = better. Used to pick which print survives a dust. */
export const CONDITION_RANK: Record<PrintCondition, number> = {
  fresh: 2, rusted: 1, factory: 0,
};

export function rollCondition(): PrintCondition {
  let r = Math.random() * 100;
  for (const c of CONDITIONS) {
    r -= CONDITION_META[c].weight;
    if (r <= 0) return c;
  }
  return "factory";
}

export function isLegendary(cardId: string): boolean {
  return CARDS[cardId]?.rarity === "legendary";
}

export type PrintInfo = { cardId: string; serial: number; condition: string };

// The tx handed to every helper — whatever prisma.$transaction provides.
type Tx = Prisma.TransactionClient;

/**
 * Mint `n` new prints of a card for a user, serials handed out atomically.
 * Call ONLY for legendaries and ONLY inside the transaction that grants the
 * copies, so a failed grant never leaves orphan prints.
 */
export async function mintPrints(
  tx: Tx,
  userId: string,
  cardId: string,
  n: number
): Promise<PrintInfo[]> {
  if (n <= 0) return [];
  const counter = await tx.printCounter.upsert({
    where: { cardId },
    create: { cardId, next: n + 1 },
    update: { next: { increment: n } },
    select: { next: true },
  });
  // create path: next is n+1, serials 1..n. update path: next is the value
  // AFTER incrementing, so the block we own starts at next - n.
  const start = counter.next - n;
  const out: PrintInfo[] = [];
  for (let i = 0; i < n; i++) {
    const condition = rollCondition();
    await tx.cardPrint.create({
      data: { cardId, serial: start + i, condition, userId },
    });
    out.push({ cardId, serial: start + i, condition });
  }
  return out;
}

/**
 * Destroy `n` prints a user holds of a card, WORST first (factory before
 * rusted before fresh, newest serial first within a condition) — dusting and
 * attuning consume the copies a collector values least.
 */
/**
 * Wear-aware duplicates: a Fresh Build and a Factory New of the same card
 * are DIFFERENT objects, never duplicates of each other. Only extras WITHIN
 * one wear count — the lowest serial of each wear survives (the copy a
 * collector leads with), later serials are the dust. Returns the print ids
 * that qualify; the caller decides what to do with them.
 */
export async function findDuplicatePrints(
  tx: Tx,
  userId: string,
  cardId: string
): Promise<string[]> {
  const held = await tx.cardPrint.findMany({
    where: { userId, cardId },
    select: { id: true, serial: true, condition: true },
  });
  const byCond = new Map<string, { id: string; serial: number }[]>();
  for (const p of held) {
    const list = byCond.get(p.condition) || [];
    list.push({ id: p.id, serial: p.serial });
    byCond.set(p.condition, list);
  }
  const extras: string[] = [];
  for (const list of byCond.values()) {
    list.sort((a, b) => a.serial - b.serial);
    for (let i = 1; i < list.length; i++) extras.push(list[i].id);
  }
  return extras;
}

export async function burnWorstPrints(
  tx: Tx,
  userId: string,
  cardId: string,
  n: number
): Promise<void> {
  if (n <= 0) return;
  const held = await tx.cardPrint.findMany({
    where: { userId, cardId },
    select: { id: true, serial: true, condition: true },
  });
  const worstFirst = held.sort((a, b) => {
    const ra = CONDITION_RANK[a.condition as PrintCondition] ?? 0;
    const rb = CONDITION_RANK[b.condition as PrintCondition] ?? 0;
    if (ra !== rb) return ra - rb;      // worse condition burns first
    return b.serial - a.serial;         // newer serial burns first
  });
  const ids = worstFirst.slice(0, n).map((p) => p.id);
  if (ids.length) await tx.cardPrint.deleteMany({ where: { id: { in: ids } } });
}

/**
 * Escrow `n` prints into a listing, worst first — a seller keeps their best
 * copies unless they list everything. Returns how many were actually moved
 * (pre-backfill users may briefly hold fewer prints than copies; the market
 * must not hard-fail on that).
 */
export async function escrowPrints(
  tx: Tx,
  userId: string,
  cardId: string,
  listingId: string,
  n: number
): Promise<number> {
  if (n <= 0) return 0;
  const held = await tx.cardPrint.findMany({
    where: { userId, cardId },
    select: { id: true, serial: true, condition: true },
  });
  const worstFirst = held.sort((a, b) => {
    const ra = CONDITION_RANK[a.condition as PrintCondition] ?? 0;
    const rb = CONDITION_RANK[b.condition as PrintCondition] ?? 0;
    if (ra !== rb) return ra - rb;
    return b.serial - a.serial;
  });
  const ids = worstFirst.slice(0, n).map((p) => p.id);
  if (ids.length) {
    await tx.cardPrint.updateMany({
      where: { id: { in: ids } },
      data: { userId: null, listingId },
    });
  }
  return ids.length;
}

/**
 * Escrow EXACT prints by serial — the seller chose which copies to part
 * with, so wear tiers stop being one stack and become their own assets.
 * Returns how many actually moved; the caller must treat a shortfall as a
 * conflict (someone raced them) and roll the whole listing back.
 */
export async function escrowSerials(
  tx: Tx,
  userId: string,
  cardId: string,
  listingId: string,
  serials: number[]
): Promise<number> {
  if (!serials.length) return 0;
  const moved = await tx.cardPrint.updateMany({
    where: { userId, cardId, serial: { in: serials } },
    data: { userId: null, listingId },
  });
  return moved.count;
}

/** Return escrowed prints to their seller (listing cancelled). */
export async function releasePrints(
  tx: Tx,
  listingId: string,
  toUserId: string
): Promise<void> {
  await tx.cardPrint.updateMany({
    where: { listingId },
    data: { userId: toUserId, listingId: null },
  });
}

/** Hand escrowed prints to the buyer (listing sold). */
export async function transferPrints(
  tx: Tx,
  listingId: string,
  buyerId: string
): Promise<void> {
  await tx.cardPrint.updateMany({
    where: { listingId },
    data: { userId: buyerId, listingId: null },
  });
}
