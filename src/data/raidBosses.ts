import { CardRarity } from "./cardCatalog";

/**
 * GUILD RAID BOSS — season one's eight bosses, one per ISO week, rotating.
 *
 * Everything the damage formula needs to know about a week lives here as
 * data, so adding season two is a content change, not an engineering one.
 * `series` values are REAL catalog set names — affinity can only ever fire
 * if these match `CatalogCard.set` exactly.
 *
 * Art: `art` is a frontend public path; phase 1 ships with these paths
 * unfilled on disk (the page falls back to a styled placeholder), the owner
 * supplies real pieces by phase 4 (flag visible artist signatures once).
 */

export type RaidGimmick =
  | { kind: "none" }
  | { kind: "rarityBoost"; rarities: CardRarity[]; mult: number }
  | { kind: "affinityDouble" }
  | { kind: "ironHide"; damageMult: number; rewardMult: number }
  | { kind: "glassCannon"; damageMult: number; injuryMult: number }
  | { kind: "collectorsPride"; perSet: number; cap: number }
  | { kind: "finale"; hpMult: number; rewardMult: number };

export interface RaidBossDef {
  slug: string;
  name: string;
  /** A REAL catalog set name — the affinity axis. */
  series: string;
  /** Frontend public path for the hero art. */
  art: string;
  flavor: string;
  /** One plain sentence the UI shows for the week's rule. */
  gimmickText: string;
  gimmick: RaidGimmick;
}

export const RAID_BOSSES: RaidBossDef[] = [
  {
    slug: "herald-of-dawn",
    name: "The Herald of Dawn",
    series: "Ascension",
    art: "/raid/herald-of-dawn.webp",
    flavor: "The first boss asks only one thing: show up.",
    gimmickText: "Opening ceremony — no modifier. A fair fight.",
    gimmick: { kind: "none" },
  },
  {
    slug: "pale-usurper",
    name: "The Pale Usurper",
    series: "Knight",
    art: "/raid/pale-usurper.webp",
    flavor: "It remembers every knight that ever knelt.",
    gimmickText: "Underdog's hour — common and rare cards deal ×1.6 damage.",
    gimmick: { kind: "rarityBoost", rarities: ["common", "rare"], mult: 1.6 },
  },
  {
    slug: "drowned-choir",
    name: "The Drowned Choir",
    series: "Abyssal",
    art: "/raid/drowned-choir.webp",
    flavor: "It sings back whatever you bring to it.",
    gimmickText: "Mirror match — series affinity is doubled (×2.0).",
    gimmick: { kind: "affinityDouble" },
  },
  {
    slug: "sarcophage",
    name: "The Sarcophage",
    series: "Requiem",
    art: "/raid/sarcophage.webp",
    flavor: "Bury it faster than it buries you.",
    gimmickText: "Iron hide — all damage ×0.7, but kill rewards +50%.",
    gimmick: { kind: "ironHide", damageMult: 0.7, rewardMult: 1.5 },
  },
  {
    slug: "mercy-eater",
    name: "The Mercy Eater",
    series: "Succour",
    art: "/raid/mercy-eater.webp",
    flavor: "It feeds on hesitation.",
    gimmickText: "Glass cannon — damage ×1.4, injury chance doubled.",
    gimmick: { kind: "glassCannon", damageMult: 1.4, injuryMult: 2 },
  },
  {
    slug: "thousand-banner-shogun",
    name: "The Thousand-Banner Shogun",
    series: "Ronin",
    art: "/raid/thousand-banner-shogun.webp",
    flavor: "It has beaten every army that fought with one idea.",
    gimmickText: "Collector's pride — +4% damage per distinct set you've fielded this week (up to +40%).",
    gimmick: { kind: "collectorsPride", perSet: 0.04, cap: 0.4 },
  },
  {
    slug: "star-swallower",
    name: "The Star Swallower",
    series: "Sorcerer",
    art: "/raid/star-swallower.webp",
    flavor: "Only legends cast shadows big enough to hide in.",
    gimmickText: "Twilight of legends — legendary and mythic cards deal ×1.5 damage.",
    gimmick: { kind: "rarityBoost", rarities: ["legendary", "mythic"], mult: 1.5 },
  },
  {
    slug: "vigil-breaker",
    name: "The Vigil-Breaker",
    series: "Vigil",
    art: "/raid/vigil-breaker.webp",
    flavor: "The season ends where the watch began.",
    gimmickText: "The finale — boss HP +25%, every reward doubled.",
    gimmick: { kind: "finale", hpMult: 1.25, rewardMult: 2 },
  },
];

/** Deterministic boss for an ISO week key like "2026-W33". */
export function bossForWeek(week: string): RaidBossDef {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  const year = m ? parseInt(m[1], 10) : 0;
  const wk = m ? parseInt(m[2], 10) : 0;
  // Year folds in so week 1 doesn't repeat week 53's boss two years running.
  const idx = ((year * 53 + wk) % RAID_BOSSES.length + RAID_BOSSES.length) % RAID_BOSSES.length;
  return RAID_BOSSES[idx];
}

export function bossBySlug(slug: string): RaidBossDef {
  return RAID_BOSSES.find((b) => b.slug === slug) || RAID_BOSSES[0];
}

// ── gimmick math, kept beside the data it interprets ───────────────────────

export function gimmickDamageMult(g: RaidGimmick, rarity: CardRarity): number {
  if (g.kind === "rarityBoost" && g.rarities.includes(rarity)) return g.mult;
  if (g.kind === "ironHide") return g.damageMult;
  if (g.kind === "glassCannon") return g.damageMult;
  return 1;
}

export function gimmickAffinityMult(g: RaidGimmick): number {
  return g.kind === "affinityDouble" ? 2.0 : 1.5;
}

/** Attack-wide bonus from set variety this week (collectorsPride only). */
export function gimmickVarietyMult(g: RaidGimmick, distinctSets: number): number {
  if (g.kind !== "collectorsPride") return 1;
  return 1 + Math.min(distinctSets * g.perSet, g.cap);
}

export function gimmickInjuryMult(g: RaidGimmick): number {
  return g.kind === "glassCannon" ? g.injuryMult : 1;
}

export function gimmickHpMult(g: RaidGimmick): number {
  return g.kind === "finale" ? g.hpMult : 1;
}

export function gimmickRewardMult(g: RaidGimmick): number {
  if (g.kind === "ironHide") return g.rewardMult;
  if (g.kind === "finale") return g.rewardMult;
  return 1;
}

// ── tuning constants ────────────────────────────────────────────────────────

export const RAID = {
  FREE_ATTACKS_PER_DAY: 2,
  MAX_ATTACKS_PER_DAY: 3, // the third is the Rally, bought with AP in-transaction
  RALLY_COST_AP: 150,
  SQUAD_SIZE: 3,
  INJURY_CHANCE: 0.07,
  INJURY_CHANCE_FRESH: 0.04, // fresh-condition legendary prints are hardier
  INJURY_REST_HOURS: 36,
  // HP sizing (§3.4 of the spec): participation-scaled, never level-scaled.
  HP_ATTACKS_PER_MEMBER: 14, // 2 free × 7 days; rallies are surplus on purpose
  HP_TUNING: 0.85,
  HP_ACTIVE_MIN: 8, // realm-mode clamps (whole server is one "guild")
  HP_ACTIVE_MAX: 80,
  GUILD_HP_ACTIVE_MIN: 3, // per-guild floor — a 3-person guild still gets a boss it can plausibly kill
  COLD_START_AVG_DAMAGE: 900,
  // §6 payouts (realm mode: personal rewards only — guild coins wait for guilds)
  KILL_AP: 400,
  KILL_SHARDS: 25,
  CONSISTENCY_ATTACKS: 15,
  CONSISTENCY_AP: 150,
  TOP_DAMAGE_SHARDS: [40, 25, 15],
  REWARD_GATE_ATTACKS: 3,
  ESCAPE_CLOSE_RATIO: 0.9,
  ESCAPE_CLOSE_FRACTION: 0.4,
  ESCAPE_FAR_FRACTION: 0.25,
  // rarity multipliers over the REAL tier set
  RARITY_MULT: {
    common: 1.0,
    rare: 1.35,
    epic: 1.8,
    event: 1.8,
    legendary: 3.0,
    mythic: 4.5,
  } as Record<CardRarity, number>,
  CONDITION_MULT: { fresh: 1.15, factory: 1.0, rusted: 0.9 } as Record<string, number>,
} as const;
