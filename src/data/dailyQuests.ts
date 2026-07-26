/**
 * Daily quests — bonus Arise Points for things users already do.
 *
 * Two independent clocks, which is the thing to keep straight:
 *
 *   · PROGRESS + CLAIMS reset DAILY at UTC midnight.
 *   · The LINEUP rotates every ROTATION_DAYS, so the board doesn't go stale.
 *
 * Deliberately NO new tables. PointLog already records every earn event with a
 * `reason` and a `createdAt`, and the earn endpoints already dedup by exact
 * reason string. So:
 *
 *   progress = today's PointLog rows matching the quest
 *   claimed  = a PointLog row `quest:<id>:<YYYY-MM-DD>`
 *
 * That reuses the existing economy end to end: quest payouts land in the same
 * ledger the user can already see on their profile, and show up in the console's
 * economy tab for free.
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

/** How many days a lineup stays up. Change this one number to 5 for a 5-day cycle. */
export const ROTATION_DAYS = 3;

/** Anchor for cycle counting. Fixed forever — moving it reshuffles every board. */
const EPOCH_MS = Date.UTC(2026, 0, 1);

export type QuestMatch =
  | { kind: "prefix"; value: string }
  | { kind: "prefixAny"; values: string[] }
  | { kind: "exact"; value: string }
  | { kind: "checkin" };

export interface DailyQuest {
  id: string;
  label: string;
  hint: string;
  target: number;
  ap: number;
  xp: number;
  match: QuestMatch;
}

/**
 * The check-in is always on the board. It guarantees there is at least one
 * claimable quest every single day, so a user who opens the app on a day they
 * don't watch or read anything still has something to collect.
 */
export const ANCHOR_QUEST: DailyQuest = {
  id: "checkin",
  label: "Daily check-in",
  hint: "Just show up. Claim it and go.",
  target: 1,
  ap: 5,
  xp: 5,
  match: { kind: "checkin" },
};

/**
 * The rotating pool, bucketed by category. Each cycle takes ONE quest from each
 * bucket, advancing through that bucket by cycle index.
 *
 * Bucketing rather than picking N at random from a flat list is deliberate: it
 * guarantees every board has one watch goal, one reading goal, one social goal
 * and one cross-cutting goal, so a rotation can never serve up four anime quests
 * to someone who only reads manhwa.
 */
const POOL: Record<string, DailyQuest[]> = {
  watch: [
    { id: "watch1", label: "Watch an episode", hint: "Any anime. One episode is enough.", target: 1, ap: 8, xp: 12, match: { kind: "prefix", value: "watch:" } },
    { id: "watch3", label: "Watch 3 episodes", hint: "Any anime, any series — new episodes only.", target: 3, ap: 15, xp: 30, match: { kind: "prefix", value: "watch:" } },
    { id: "watch5", label: "Marathon 5 episodes", hint: "A proper sitting. New episodes only.", target: 5, ap: 25, xp: 45, match: { kind: "prefix", value: "watch:" } },
  ],
  read: [
    { id: "read3", label: "Read 3 chapters", hint: "Manhwa or light novels both count.", target: 3, ap: 10, xp: 20, match: { kind: "prefix", value: "read:" } },
    { id: "read5", label: "Read 5 chapters", hint: "Manhwa or light novels both count.", target: 5, ap: 15, xp: 30, match: { kind: "prefix", value: "read:" } },
    { id: "read10", label: "Binge 10 chapters", hint: "One more chapter. Just one more.", target: 10, ap: 28, xp: 50, match: { kind: "prefix", value: "read:" } },
  ],
  social: [
    { id: "comment1", label: "Share a view", hint: "Post once in the community or on any title.", target: 1, ap: 10, xp: 15, match: { kind: "exact", value: COMMENT_REASON } },
    { id: "comment3", label: "Start 3 conversations", hint: "Three posts anywhere on Da Vinci.", target: 3, ap: 22, xp: 35, match: { kind: "exact", value: COMMENT_REASON } },
    { id: "track1", label: "Add to your library", hint: "Track a manhwa or novel you're following.", target: 1, ap: 10, xp: 10, match: { kind: "prefix", value: "track:" } },
  ],
  mixed: [
    { id: "mix5", label: "5 episodes or chapters", hint: "Watching and reading both count toward this.", target: 5, ap: 18, xp: 30, match: { kind: "prefixAny", values: ["watch:", "read:"] } },
    { id: "mix10", label: "10 episodes or chapters", hint: "Any mix of watching and reading.", target: 10, ap: 30, xp: 55, match: { kind: "prefixAny", values: ["watch:", "read:"] } },
    { id: "mix3", label: "3 episodes or chapters", hint: "An easy one. Anything counts.", target: 3, ap: 12, xp: 20, match: { kind: "prefixAny", values: ["watch:", "read:"] } },
  ],
};

const BUCKET_ORDER = ["watch", "read", "social", "mixed"] as const;

/** Completing every quest on the current board pays this on top. */
export const ALL_DONE_BONUS = { id: "allclear", ap: 25, xp: 40 };

/** Which rotation cycle a given moment falls in. */
export function cycleIndex(d: Date = new Date()): number {
  const days = Math.floor((startOfUtcDay(d).getTime() - EPOCH_MS) / 86_400_000);
  return Math.floor(days / ROTATION_DAYS);
}

/** When the current lineup is replaced. */
export function cycleEndsAt(d: Date = new Date()): Date {
  const next = cycleIndex(d) + 1;
  return new Date(EPOCH_MS + next * ROTATION_DAYS * 86_400_000);
}

/**
 * The board for a given moment: the anchor plus one quest from each bucket.
 * Pure and deterministic — same cycle always yields the same lineup, on every
 * server and on every request, with nothing persisted.
 */
export function activeQuests(d: Date = new Date()): DailyQuest[] {
  const c = cycleIndex(d);
  const picks: DailyQuest[] = [ANCHOR_QUEST];
  BUCKET_ORDER.forEach((bucket, i) => {
    const list = POOL[bucket]!;
    // Offsetting by the bucket index staggers the buckets so they don't all
    // advance in lockstep — otherwise every cycle would be "all the easy ones"
    // then "all the hard ones".
    picks.push(list[(c + i) % list.length]!);
  });
  return picks;
}

/** Look a quest up ANYWHERE in the pool — not just the current board. */
export function getQuest(id: string): DailyQuest | undefined {
  if (id === ANCHOR_QUEST.id) return ANCHOR_QUEST;
  for (const bucket of BUCKET_ORDER) {
    const hit = POOL[bucket]!.find((q) => q.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** UTC day key. Reset is server-authoritative and identical for everyone; the
 *  API returns resetsAt so the UI shows an honest countdown rather than guessing
 *  from the client clock. */
export function dayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function startOfUtcDay(d: Date = new Date()): Date {
  return new Date(`${dayKey(d)}T00:00:00.000Z`);
}

export function nextUtcMidnight(d: Date = new Date()): Date {
  return new Date(startOfUtcDay(d).getTime() + 86_400_000);
}

export function claimReason(questId: string, day: string = dayKey()): string {
  return `${QUEST_PREFIX}${questId}:${day}`;
}
