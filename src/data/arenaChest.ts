import crypto from "crypto";
import { ARENA_EFFECTS, type ArenaEffectDef, type ArenaGrade } from "./arenaEffects";

// ═══════════════════════════════════════════════════════════════════════════
// THE ARENA CACHE — one chest, one roll, one arena effect.
//
// Arena effects can still be bought outright at a fixed price. The Cache is the
// gamble: cheaper than any arena above A grade, but it decides which one you
// get. Odds are PUBLISHED on the shop tile — a six-item pool is reverse
// engineered in a weekend, and being caught hiding rates is worse than the
// rates being bad.
//
// WEIGHT IS PER GRADE, NEVER PER ITEM. A grade's weight is spent once and then
// split evenly among its members. That is the only construction that makes the
// two SSS effects 2.5% each rather than 5% each — weighting per item would
// double-count every grade that has more than one member.
//
// The roll runs HERE, on the server, and the caller must not read a grade, an
// item or a price out of the request. Same closed-list rule as openPack().
// ═══════════════════════════════════════════════════════════════════════════

// ══ MIRROR BLOCK — keep in sync with the frontend src/data/arenaChest.ts ══

export const GRADE_WEIGHT: Record<ArenaGrade, number> = { A: 44, S: 31, SS: 20, SSS: 5 };

/**
 * What a duplicate pays back, keyed on GRADE rather than on the effect's price
 * so that re-pricing an arena can never silently move refunds.
 *
 * Every one of these is far below the chest price, which is what makes farming
 * impossible: since each individual outcome loses money, so does every possible
 * run of them. Even a forced best-case SSS dupe bleeds 1,200 AP per open.
 */
export const DUPE_REFUND: Record<ArenaGrade, number> = { A: 300, S: 550, SS: 900, SSS: 1400 };

export interface ArenaChestDef {
  id: string;
  name: string;
  price: number;
  blurb: string;
  /** Omit a grade to exclude it from this chest entirely. */
  weights: Partial<Record<ArenaGrade, number>>;
  /** Dupes needed before the next roll is guaranteed NEW. 0 disables pity. */
  pityAfter: number;
  availableUntil?: string;
}

export const ARENA_CHESTS: Record<string, ArenaChestDef> = {
  chest_arena_small: {
    id: "chest_arena_small",
    name: "Arena Cache",
    price: 2600,
    weights: GRADE_WEIGHT,
    pityAfter: 10,
    blurb: "One arena effect. Which one is up to the Cache.",
  },
};

// ══ END MIRROR BLOCK ══

export function arenaChest(id?: string | null): ArenaChestDef | null {
  return (id && ARENA_CHESTS[id]) || null;
}

/** Still on sale? Mirrors isAvailable() in shopCatalog for limited chests. */
export function chestAvailable(chest: ArenaChestDef): boolean {
  return !chest.availableUntil || Date.now() <= Date.parse(chest.availableUntil);
}

/**
 * Everything this chest can roll — scoped to the CHEST, not to ARENA_EFFECTS.
 * A future SS-and-up vault therefore becomes unbuyable once you own its four,
 * even while Golden Hour is still missing from your collection.
 */
export function chestPool(chest: ArenaChestDef): ArenaEffectDef[] {
  return Object.values(ARENA_EFFECTS).filter((fx) => (chest.weights[fx.grade] ?? 0) > 0);
}

const GRADE_ORDER: ArenaGrade[] = ["A", "S", "SS", "SSS"];

/**
 * Roll one effect.
 *
 * Pure — no I/O — so it runs BEFORE the transaction opens, exactly like
 * rollPack(). It decides WHAT was rolled; the database decides whether that is
 * new or a duplicate, because only the database can do that without a race.
 *
 * PITY guarantees a NEW effect, never a grade. In a six-item pool the thing
 * that actually makes people quit is paying full price for their fourth Golden
 * Hour, and a no-duplicate floor fixes that directly. A guaranteed SSS would
 * instead make the Cache the cheap route to a 14,000 AP effect, which would
 * turn that price into a lie. The pity roll is still grade-weighted, so a
 * player missing both Golden Hour and Noir still draws Golden Hour 44:5.
 */
export function rollArenaChest(
  chest: ArenaChestDef,
  owned: string[],
  pity: number
): { effect: ArenaEffectDef; pityHit: boolean } {
  const full = chestPool(chest);

  const pityHit =
    chest.pityAfter > 0 && pity >= chest.pityAfter && full.some((fx) => !owned.includes(fx.id));
  const pool = pityHit ? full.filter((fx) => !owned.includes(fx.id)) : full;

  const byGrade: Partial<Record<ArenaGrade, ArenaEffectDef[]>> = {};
  for (const fx of pool) (byGrade[fx.grade] ||= []).push(fx);

  // Cheapest grade FIRST. If the walk below is ever wrong it lands on grades[0],
  // and that must never be a free 14,000 AP jackpot.
  const grades = GRADE_ORDER.filter(
    (g) => (byGrade[g]?.length ?? 0) > 0 && (chest.weights[g] ?? 0) > 0
  );
  if (grades.length === 0) {
    // Only reachable if a chest is defined with no valid grades at all.
    const any = full[0] ?? Object.values(ARENA_EFFECTS)[0];
    return { effect: any, pityHit: false };
  }

  // Recomputed from the SURVIVING grades every call, never hardcoded to 100 —
  // the pity filter can remove a whole grade, and a stale total would drop
  // that share of rolls through the loop onto the fallback.
  const total = grades.reduce((s, g) => s + (chest.weights[g] ?? 0), 0);

  // randomInt gives an integer in [0, total), so there is no float edge case
  // and no way to fall past the last bucket. Do NOT "simplify" this back to
  // Math.random() for symmetry with rollPack().
  let r = crypto.randomInt(0, total);
  let picked = grades[0];
  for (const g of grades) {
    const w = chest.weights[g] ?? 0;
    if (r < w) { picked = g; break; }
    r -= w;
  }

  const members = byGrade[picked]!;
  // randomInt's upper bound is exclusive: [0, length). Math.round(rand*n) would
  // index n (undefined), and floor(rand*(n-1)) would make the last member
  // unreachable — with two SSS members that is one of Noir/Void Rift NEVER
  // dropping, a 50% error invisible without thousands of rolls.
  return { effect: members[crypto.randomInt(0, members.length)], pityHit };
}
