/**
 * Daily quests — bonus Arise Points for things users already do.
 *
 * Deliberately NO new tables. PointLog already records every earn event with a
 * `reason` and a `createdAt`, and the earn endpoints already dedup by exact
 * reason string. So:
 *
 *   · PROGRESS  = count today's PointLog rows whose reason matches the quest
 *   · CLAIMED   = a PointLog row with reason `quest:<id>:<YYYY-MM-DD>`
 *
 * That reuses the existing economy end to end: quest payouts land in the same
 * ledger the user can already see on their profile, they show up in the console's
 * economy tab for free, and the dedup story is identical to `earnPoints`.
 *
 * The reason formats below were confirmed against PRODUCTION data, not guessed:
 *   watch:<animeId>:<episode>   (user.controller.ts addXpForWatching)
 *   read:<key>                  (user.controller.ts earnPoints)
 *   track:<key>                 (user.controller.ts earnPoints)
 *   "Shared your views with the community"  (comment.controller.ts — a plain
 *                               sentence, NOT a prefixed key; do not "tidy" it
 *                               without updating COMMENT_REASON here)
 */

export const QUEST_PREFIX = "quest:";
export const COMMENT_REASON = "Shared your views with the community";

export interface DailyQuest {
  id: string;
  label: string;
  hint: string;
  target: number;
  ap: number;
  xp: number;
  /** Which ledger reasons count toward this quest. */
  match:
    | { kind: "prefix"; value: string }
    | { kind: "exact"; value: string }
    | { kind: "checkin" };
}

export const DAILY_QUESTS: DailyQuest[] = [
  {
    id: "checkin",
    label: "Daily check-in",
    hint: "Just show up. Claim it and go.",
    target: 1,
    ap: 5,
    xp: 5,
    match: { kind: "checkin" },
  },
  {
    id: "watch3",
    label: "Watch 3 episodes",
    hint: "Any anime, any series — new episodes only.",
    target: 3,
    ap: 15,
    xp: 30,
    match: { kind: "prefix", value: "watch:" },
  },
  {
    id: "read5",
    label: "Read 5 chapters",
    hint: "Manhwa or light novels both count.",
    target: 5,
    ap: 15,
    xp: 30,
    match: { kind: "prefix", value: "read:" },
  },
  {
    id: "comment1",
    label: "Share a view",
    hint: "Post once in the community or on any title.",
    target: 1,
    ap: 10,
    xp: 15,
    match: { kind: "exact", value: COMMENT_REASON },
  },
  {
    id: "track1",
    label: "Add to your library",
    hint: "Track a manhwa or novel you're following.",
    target: 1,
    ap: 10,
    xp: 10,
    match: { kind: "prefix", value: "track:" },
  },
];

/** Completing every quest in a day pays this on top. */
export const ALL_DONE_BONUS = { id: "allclear", ap: 25, xp: 40 };

export function getQuest(id: string): DailyQuest | undefined {
  return DAILY_QUESTS.find((q) => q.id === id);
}

/** UTC day key. The reset is server-authoritative and the same for everyone —
 *  the API returns `resetsAt` so the UI can show an honest countdown rather than
 *  guessing from the client clock. */
export function dayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function startOfUtcDay(d: Date = new Date()): Date {
  return new Date(`${dayKey(d)}T00:00:00.000Z`);
}

export function nextUtcMidnight(d: Date = new Date()): Date {
  const start = startOfUtcDay(d);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

export function claimReason(questId: string, day: string = dayKey()): string {
  return `${QUEST_PREFIX}${questId}:${day}`;
}
