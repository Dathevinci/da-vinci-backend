// ═══════════════════════════════════════════════════════════
// Arise Points (currency) + XP (leveling) economy.
//
// XP drives the profile level — levels 1..100 on a QUADRATIC curve, defined in
// the USER LEVEL CURVE block below (it used to be max 10 and exponential; the
// why is in that block). Arise Points are a separate community currency.
// Earning AP also grants a small passive amount of XP so the two systems
// connect.
// ═══════════════════════════════════════════════════════════

export type Role = "LEAD_DEV" | "ADMIN" | "USER";

const LEAD_DEV = ["dejavuh"];
// Fallback ONLY — the persistent `role` column is authoritative (see
// backfill-roles.ts). Keep in sync with the frontend src/lib/admin.ts.
const ADMINS = ["davinci", "xhackerdevil", "coffee", "speyvenerable", "ash"];

export function getRole(username: string | null | undefined): Role {
  const u = (username || "").toLowerCase();
  if (LEAD_DEV.includes(u)) return "LEAD_DEV";
  if (ADMINS.includes(u)) return "ADMIN";
  return "USER";
}

// ═══ USER LEVEL CURVE ═══════════════════════════════════════════════════════
//
// ⚠ THIS MATH IS DUPLICATED IN THE FRONTEND. da-vinci-frontend
//   src/lib/levels.ts carries the IDENTICAL formula, and THE TWO MUST NEVER
//   DRIFT. The server gates off this curve (guild minLevel admission) while
//   the client draws the bar and the rank title off its own copy — one
//   character of disagreement and a user is shown a level the server refuses
//   to honour, or is bounced from a guild the UI said they qualified for.
//   Change one, change both, in the same commit.
//
//   USER_MAX_LEVEL     = 100
//   userLevelCost(L)   = 100 + (L-1)*80                 xp to go from L to L+1
//   userTotalXpFor(L)  = 100*(L-1) + 80*(L-1)*(L-2)/2   cumulative xp AT L
//   userTotalXpFor(100) = 397,980 — the ceiling.
//
// WHY IT CHANGED: the old curve was 1000 * 2^(L-1), capped at level 10 —
// level 10 alone demanded 511,000 xp while the actions on this site grant
// 5-25 xp a piece. Measured against the LIVE data (59 users: median 20 xp,
// 22 of them sitting at zero, p25 1,084) progression was simply dead for
// everyone outside the top four accounts. The replacement is QUADRATIC, not
// exponential: level 2 costs 100 xp — about an hour of watching at
// XP_PER_MINUTE, or ~17 comments — and every step after that grows by a flat
// 80, so the ladder stays climbable all the way to 100 instead of doubling
// out of reach. Against the same live accounts: 384,307 xp -> L98,
// 164,930 -> L64, 90,106 -> L47, 71,254 -> L42, 12,779 -> L18, 1,084 -> L5,
// 20 -> L1 with visible progress. Nobody is stranded at 1, nobody is
// force-capped at 100.
//
// Level is DERIVED from xp and never stored, so it cannot drift from the
// number that defines it.

export const USER_MAX_LEVEL = 100;

/** Clamp anything a caller hands us into a real level. NaN/Infinity -> 1. */
const asUserLevel = (level: number): number => {
  const L = Math.floor(Number(level));
  if (!Number.isFinite(L)) return 1;
  return Math.max(1, Math.min(USER_MAX_LEVEL, L));
};

/** Clamp anything a caller hands us into a real xp total. NaN, Infinity and
 *  negatives all collapse to 0 rather than poisoning the comparison below —
 *  xp arrives from a column that should never hold either, but a level is a
 *  gate and a gate does not get to throw. */
const asUserXp = (xp: number): number => {
  const x = Math.floor(Number(xp));
  return Number.isFinite(x) ? Math.max(0, x) : 0;
};

/** XP to go from `level` to the next one. Flat past the ceiling. */
export const userLevelCost = (level: number): number => 100 + (asUserLevel(level) - 1) * 80;

/** Cumulative XP a user must have banked to BE at `level`. */
export const userTotalXpFor = (level: number): number => {
  const L = asUserLevel(level);
  return 100 * (L - 1) + (80 * (L - 1) * (L - 2)) / 2;
};

/** The largest level in [1,100] whose entry cost this xp has paid. */
export const userLevel = (xp: number): number => {
  const x = asUserXp(xp);
  let level = 1;
  while (level < USER_MAX_LEVEL && x >= userTotalXpFor(level + 1)) level++;
  return level;
};

// ── THE DIAL ───────────────────────────────────────────────────────────────
// Everything you do here is paid in ENGAGEMENT MINUTES × this rate. One number
// moves the whole economy; change it and every payout follows.
//
// Why minutes: flat per-unit payouts silently made manhwa 2.6x more profitable
// per hour than anime (3 AP for a 24-minute episode vs 2 AP for a 5-minute
// chapter), which rewarded CLICKING through chapters rather than reading them.
// Paying for time makes an hour worth an hour whatever you spent it on.
export const AP_PER_MINUTE = 3; // 180 AP per hour of engagement
export const XP_PER_MINUTE = 1.5;

// How long a unit of each content type actually takes. Anime uses the real
// episode duration when the client sends one (clamped below) and falls back to
// DEFAULT_EP_MINUTES.
export const CONTENT_MINUTES = {
  manhwaChapter: 6,
  novelChapter: 12,
} as const;

// Anti-farm ceiling: the most AP one account can earn from content in a day,
// derived from the pointLog ledger rather than a new column. ~4 hours of paid
// engagement — generous for a real reader, useless to a script.
export const DAILY_AP_CAP = 700;

// Flat payouts for one-off actions that aren't time-based. These are small on
// purpose: they mark a moment, they aren't a wage.
export const PAYOUTS = {
  watch: { ap: 3, xp: 25 },   // legacy fallback — timeAward() is the real path
  read:  { ap: 2, xp: 15 },   // legacy fallback
  track: { ap: 50, xp: 20 },  // first time adding a manhwa/novel to your library
  comment: { ap: 15, xp: 5 },
  follow: { ap: 10, xp: 0 },
} as const;

/**
 * Pay for time. `minutes` is clamped so a client can't claim a 40-hour episode.
 */
export function timeAward(minutes: number): { ap: number; xp: number } {
  const m = Math.min(MAX_EP_MINUTES, Math.max(1, Math.round(minutes || 0)));
  return { ap: Math.round(m * AP_PER_MINUTE), xp: Math.round(m * XP_PER_MINUTE) };
}

/**
 * Minutes for a `read` earn key. The key already encodes which library it came
 * from ("manhwa:<id>:<ch>" / "novel:<id>:<ch>"), so no extra client input is
 * needed — and no client input means nothing new to forge.
 */
export function readMinutes(key: string): number {
  return key.startsWith("novel:") ? CONTENT_MINUTES.novelChapter : CONTENT_MINUTES.manhwaChapter;
}

export type EconomyAction = keyof typeof PAYOUTS;

// Total (AP, XP) increments for an action, including the passive XP-from-AP bridge.
export function payout(action: EconomyAction): { ap: number; xp: number } {
  const { ap, xp } = PAYOUTS[action];
  return { ap, xp: xp + Math.floor(ap / 10) };
}

/**
 * How much of `want` this user may still be paid today.
 *
 * Derived from the pointLog ledger — no new column, no migration, and it can
 * never drift out of sync with the balance it governs. Only POSITIVE entries
 * count, so spending in the shop doesn't hand back earning headroom.
 *
 * Returns 0 when the cap is already spent; the caller should then award
 * nothing and say so rather than silently paying less than it logged.
 */
export async function remainingDailyAp(
  prisma: { pointLog: { aggregate: Function } },
  userId: string,
  want: number
): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const agg = await prisma.pointLog.aggregate({
    // Only CONTENT earnings count toward the grind cap. Auction refunds land in
    // the ledger as positive entries too (points coming back to your wallet
    // when you're outbid), and counting those as "earned today" would let a
    // bidding war silently eat your ability to earn from watching.
    where: {
      userId,
      amount: { gt: 0 },
      createdAt: { gte: since },
      NOT: { reason: { startsWith: "auction" } },
    },
    _sum: { amount: true },
  });
  const earnedToday = (agg?._sum?.amount as number) || 0;
  return Math.max(0, Math.min(want, DAILY_AP_CAP - earnedToday));
}

// ── Watch TIME ─────────────────────────────────────────────────────────────
// You're paid for the HOURS you put in, not for how many titles you tick off.
// Most TV anime run ~24 minutes an episode; fall back to that when AniList
// doesn't give us a duration.
export const DEFAULT_EP_MINUTES = 24;

// Hard sanity bounds. Both values originate from the CLIENT, so clamp here as
// well as at ingest — no episode/film runs over 4h, and AniList's longest series
// is ~3000 eps. Without this, {episodes:12, duration:9999} mints the cap.
export const MAX_EP_MINUTES = 240;
export const MAX_EPISODES = 5000;

export function watchHours(episodes?: number | null, duration?: number | null): number {
  const eps = Math.min(MAX_EPISODES, Math.max(0, Math.floor(episodes || 0)));
  if (!eps) return 0;
  const mins = Math.min(MAX_EP_MINUTES, Math.max(1, Math.floor(duration || DEFAULT_EP_MINUTES)));
  return (eps * mins) / 60;
}

// Payout for finishing an anime, priced off its RUNTIME. Tune these two numbers
// to move the whole economy. Capped per-anime so a 1000-episode epic can't mint
// a fortune in one click.
// Completion bonus. Episodes now pay their own runtime as you watch, so this
// is no longer the wage — it's the reward for actually FINISHING a series
// rather than abandoning it, worth roughly a quarter of its watch value.
export const AP_PER_HOUR = 45;
export const XP_PER_HOUR = 25;
const FINISH_AP_CAP = 1200;
const FINISH_XP_CAP = 3000;

// Awarded once per anime per user (deduped in the controller).
//
//   12 eps  ( ~4.8 h) -> +58 XP    / +10 AP
//   24 eps  ( ~9.6 h) -> +115 XP   / +19 AP
//   220 eps (~88 h)   -> +1,056 XP / +176 AP   (Naruto)
//   1100 eps (~440 h) -> +3,000 XP / +500 AP   (One Piece — hits both caps)
export function finishBonus(
  episodes: number | null | undefined,
  duration?: number | null
): { ap: number; xp: number; hours: number } {
  const hours = watchHours(episodes, duration);
  const ap = Math.min(FINISH_AP_CAP, Math.max(5, Math.round(hours * AP_PER_HOUR)));
  const xp = Math.min(FINISH_XP_CAP, Math.max(25, Math.round(hours * XP_PER_HOUR)));
  return { ap, xp, hours };
}
