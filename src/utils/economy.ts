// ═══════════════════════════════════════════════════════════
// Arise Points (currency) + XP (leveling) economy.
//
// XP drives the level (max 10, exponential — see the frontend levels.ts for
// the thresholds). Arise Points are a separate community currency. Earning AP
// also grants a small passive amount of XP so the two systems connect.
// ═══════════════════════════════════════════════════════════

export type Role = "LEAD_DEV" | "ADMIN" | "USER";

const LEAD_DEV = ["dejavuh"];
const ADMINS = ["davinci", "xhackerdevil", "coffee", "speyvenerable"];

export function getRole(username: string | null | undefined): Role {
  const u = (username || "").toLowerCase();
  if (LEAD_DEV.includes(u)) return "LEAD_DEV";
  if (ADMINS.includes(u)) return "ADMIN";
  return "USER";
}

// Base AP payout per action. XP is the direct XP, and every action also grants
// a passive XP = floor(ap / 10) so accumulating AP nudges the level bar.
export const PAYOUTS = {
  watch: { ap: 3, xp: 25 },   // per UNIQUE episode watched (deduped in the controller)
  read:  { ap: 2, xp: 15 },   // per UNIQUE manhwa/novel chapter read (deduped by reason)
  track: { ap: 5, xp: 5 },    // first time adding a manhwa/novel to your library
  comment: { ap: 5, xp: 2 },
  follow: { ap: 5, xp: 0 },
} as const;

export type EconomyAction = keyof typeof PAYOUTS;

// Total (AP, XP) increments for an action, including the passive XP-from-AP bridge.
export function payout(action: EconomyAction): { ap: number; xp: number } {
  const { ap, xp } = PAYOUTS[action];
  return { ap, xp: xp + Math.floor(ap / 10) };
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
export const AP_PER_HOUR = 2;
export const XP_PER_HOUR = 12;
const FINISH_AP_CAP = 500;
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
