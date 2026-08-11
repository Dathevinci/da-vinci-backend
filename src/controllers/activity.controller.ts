import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

/**
 * ACTIVITY HISTORY — the contribution grid on a public profile.
 *
 * NOTHING NEW IS RECORDED HERE. The PointLog ledger already holds one row per
 * episode watched and per chapter read, and every one of those writes is
 * deduped at write time (see addXpForWatching / earnPoints in
 * user.controller.ts — both bail before the insert if a row with the same
 * `reason` exists). That is what makes counting ROWS an honest count of
 * activity rather than a count of clicks: the same episode can never appear
 * twice, so a rewatch adds nothing to the grid the way it adds nothing to the
 * wallet.
 *
 * WHICH REASONS COUNT — only these two families:
 *   watch:<anilistId>:<episode>          one episode watched
 *   read:manhwa:<mangaId>:<chapterId>    one manhwa chapter read
 *   read:novel:<novelId>:<chapterId>     one novel chapter read
 * `track:*`, `follow:*`, `comment`, shop spends and the prose reasons
 * ("Updated Banner Image", "Username change to …") are NOT activity and are
 * filtered out in SQL by the startsWith pair, then again by the parser.
 *
 * ⚠ PRIVACY — PointLog is also the MONEY ledger: every row carries an `amount`.
 * These endpoints are public reads, so they must never leak the economy. Two
 * rules, both enforced below and both easy to break by accident:
 *   1. The `select` on every query here is `{ reason, createdAt }`. Never add
 *      `amount`, and never drop the select and take whole rows.
 *   2. No `reason` string is ever echoed back. A reason is an internal key —
 *      it is parsed into (kind, id, unit) and only titles, covers, counts and
 *      links leave this file.
 *
 * ⚠ UTC — every bucket boundary here is a UTC calendar day, and the payload
 * says so (`timezone: "UTC"`). The client must render the dates as given and
 * must NOT re-bucket them in local time: `new Date("2026-08-11")` is midnight
 * UTC, so anywhere west of Greenwich that renders as the 10th and the whole
 * grid slides one square left.
 */

// ── Bounds ─────────────────────────────────────────────────────────────────
// The range query is a single unbounded-in-principle scan over one user's
// ledger, and this runs on EVERY profile view, so it is capped. 20k rows is
// far past any real user (the daily AP cap makes ~700 rows/day the ceiling and
// a real one is single digits) — it exists so one pathological account cannot
// pull its entire history into memory on every visitor's page load.
const RANGE_ROW_CAP = 20000;
// One UTC day for the same reason, with a ceiling well above the daily AP cap.
const DAY_ROW_CAP = 1000;
// Rendered items for a single day. Counts above stay exact; only the list is cut.
const DAY_ITEM_CAP = 50;

const DEFAULT_DAYS = 365;
const MAX_DAYS = 365;
const DAY_MS = 86400000;

/** A whole-number or decimal unit ("12", "10.5"). Anything else is unlabelled. */
const NUMERIC = /^\d+(?:\.\d+)?$/;

/** SQL-side prefilter. Kept next to the parser so the two never drift apart. */
const ACTIVITY_REASON_FILTER = [
  { reason: { startsWith: "watch:" } },
  { reason: { startsWith: "read:" } },
];

// ── UTC day helpers ────────────────────────────────────────────────────────
// toISOString() is UTC by definition, which is the entire reason day keys are
// derived from it rather than from getFullYear()/getMonth().

/** "YYYY-MM-DD" for the UTC day a Date falls in. */
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/** Midnight UTC that opens `key`'s day. */
const dayStart = (key: string): Date => new Date(`${key}T00:00:00.000Z`);

/**
 * `key` shifted by n whole days. Plain millisecond arithmetic is exact here
 * *because* it is UTC — there are no DST jumps to make a day 23 or 25 hours.
 */
const shiftDay = (key: string, n: number): string =>
  dayKey(new Date(dayStart(key).getTime() + n * DAY_MS));

/** Shape check AND calendar check — "2026-02-31" passes the regex, not this. */
const isDayKey = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = dayStart(s);
  return !Number.isNaN(d.getTime()) && dayKey(d) === s;
};

// ── Reason parsing ─────────────────────────────────────────────────────────

export type ActivityKind = "anime" | "manhwa" | "novel";

interface ParsedActivity {
  kind: ActivityKind;
  /** anilistId (still a string here), mangaId slug, or novelId slug. */
  id: string;
  /** Raw last segment — an episode number, a chapter number, or a chapter slug. */
  unit: string | null;
}

/**
 * Split at the LAST colon.
 *
 * This is not fussiness — a novelId can legitimately CONTAIN a colon. Scraped
 * novels are keyed by source-prefixed slugs ("fmtl:omniscient-readers-viewpoint",
 * see the NovelBookmark model), so `read:novel:fmtl:orv:12` has five segments,
 * not four. The id is everything up to the final separator and the unit is the
 * final segment, which inverts how the key was built regardless of how many
 * colons the id itself carries. A naive split(":")[2] would report the novelId
 * as "fmtl" for every FanMTL title on the site.
 */
const splitLast = (s: string): { head: string; tail: string | null } => {
  const i = s.lastIndexOf(":");
  return i < 0 ? { head: s, tail: null } : { head: s.slice(0, i), tail: s.slice(i + 1) };
};

/**
 * Turn a ledger reason into an activity item, or null if it is not activity.
 *
 * DEFENSIVE BY CONTRACT: this is fed arbitrary historical strings written by
 * several code paths over the life of the site, and a profile page must not
 * 500 because one old row is shaped oddly. Anything unrecognised returns null
 * and is skipped. A row that is recognisable but missing its trailing number
 * (e.g. a bare "watch:21") still COUNTS — we know an episode was watched — it
 * just renders without a number.
 */
export function parseActivityReason(reason: unknown): ParsedActivity | null {
  if (typeof reason !== "string") return null;

  if (reason.startsWith("watch:")) {
    const { head, tail } = splitLast(reason.slice(6));
    const id = head.trim();
    if (!id) return null; // "watch:" with no anime — unusable, skip
    return { kind: "anime", id, unit: tail && tail.trim() ? tail.trim() : null };
  }

  if (reason.startsWith("read:")) {
    const rest = reason.slice(5);
    const cut = rest.indexOf(":");
    if (cut < 0) return null;
    const source = rest.slice(0, cut);
    // Only the two known libraries. A future third source is skipped rather
    // than mislabelled — an unknown shape must never be guessed at.
    if (source !== "manhwa" && source !== "novel") return null;
    const { head, tail } = splitLast(rest.slice(cut + 1));
    const id = head.trim();
    if (!id) return null;
    return { kind: source, id, unit: tail && tail.trim() ? tail.trim() : null };
  }

  return null;
}

/** "Episode 12" / "Chapter 30", or the bare noun when the unit isn't a number. */
const unitLabel = (p: ParsedActivity): string => {
  const noun = p.kind === "anime" ? "Episode" : "Chapter";
  if (p.unit && NUMERIC.test(p.unit)) return `${noun} ${Number(p.unit)}`;
  return noun;
};

/**
 * Deep link for one item. Shapes match the ones comment.controller.ts already
 * builds for notifications, so activity links land where every other link on
 * the site lands.
 */
const activityHref = (p: ParsedActivity): string | null => {
  if (p.kind === "anime") {
    const id = encodeURIComponent(p.id);
    return p.unit && NUMERIC.test(p.unit) ? `/watch/${id}?ep=${Number(p.unit)}` : `/anime/${id}`;
  }
  const base = `/${p.kind}/${encodeURIComponent(p.id)}`;
  return p.unit ? `${base}/chapter/${encodeURIComponent(p.unit)}` : base;
};

/**
 * A readable name for an id the user no longer tracks. Untracked ≠ invisible:
 * dropping the entry would silently under-report the day and make the counts
 * disagree with the grid, so the row survives with a title derived from its
 * slug ("fmtl:omniscient-readers-viewpoint" -> "Omniscient Readers Viewpoint").
 */
const fallbackTitle = (p: ParsedActivity): string => {
  if (p.kind === "anime") return `Anime #${p.id}`;
  const tail = p.id.includes(":") ? p.id.slice(p.id.lastIndexOf(":") + 1) : p.id;
  const words = tail.replace(/[-_]+/g, " ").trim();
  if (!words) return p.id.slice(0, 120);
  return words.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 120);
};

// ── GET /api/users/:id/activity?days=365 ───────────────────────────────────

/**
 * The whole grid in ONE query.
 *
 * Deliberately no user lookup: an unknown id costs one empty result set rather
 * than an extra round trip on every profile view, and "this account has no
 * activity" is the same answer either way. Also deliberately no privacy gate —
 * per the feature's contract this is a public read, same as
 * GET /:id/point-logs above it.
 */
export const getUserActivity = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.id as string;

    const rawDays = Number(req.query.days);
    const days = Number.isFinite(rawDays)
      ? Math.max(1, Math.min(MAX_DAYS, Math.floor(rawDays)))
      : DEFAULT_DAYS;

    const todayKey = dayKey(new Date());
    const requestedFrom = shiftDay(todayKey, -(days - 1)); // inclusive of both ends

    // ONE query for the entire range. Bucketing happens in JS below — a query
    // per day would be up to 365 round trips per profile view.
    // `select` is reason+createdAt ONLY: `amount` must never reach this handler.
    const rows = await prisma.pointLog.findMany({
      where: {
        userId,
        createdAt: { gte: dayStart(requestedFrom) },
        OR: ACTIVITY_REASON_FILTER,
      },
      select: { reason: true, createdAt: true },
      // Newest first so that if the cap bites, what survives is the RECENT
      // history the grid is mostly about, not a random old slice.
      orderBy: { createdAt: "desc" },
      take: RANGE_ROW_CAP,
    });

    const truncated = rows.length >= RANGE_ROW_CAP;

    const buckets = new Map<string, { episodes: number; chapters: number }>();
    for (const row of rows) {
      const parsed = parseActivityReason(row.reason);
      if (!parsed) continue;
      const key = dayKey(row.createdAt);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { episodes: 0, chapters: 0 };
        buckets.set(key, bucket);
      }
      if (parsed.kind === "anime") bucket.episodes++;
      else bucket.chapters++;
    }

    // If the cap bit, the OLDEST day we fetched is half a day — we hold some of
    // its rows and stopped mid-way. Reporting it would be a wrong number, and
    // reporting a `from` earlier than our data would imply the days before it
    // were empty. So the partial day is dropped and the range starts the day
    // after: every day reported is a day we counted in full.
    let from = requestedFrom;
    if (truncated && buckets.size > 0) {
      const keys = Array.from(buckets.keys()).sort();
      const oldest = keys[0] as string;
      if (keys.length > 1) {
        buckets.delete(oldest);
        from = shiftDay(oldest, 1);
      } else {
        // Everything landed in a single day — dropping it would report nothing
        // at all, which is worse. Keep it and let `truncated` carry the caveat.
        from = oldest;
      }
    }

    // Only days WITH activity. The client owns the empty grid — sending 365
    // mostly-zero objects would be the largest part of the payload.
    const dayList = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, b]) => ({
        date,
        episodes: b.episodes,
        chapters: b.chapters,
        total: b.episodes + b.chapters,
      }));

    const episodes = dayList.reduce((n, d) => n + d.episodes, 0);
    const chapters = dayList.reduce((n, d) => n + d.chapters, 0);
    const items = episodes + chapters;

    const spanDays = Math.max(
      1,
      Math.round((dayStart(todayKey).getTime() - dayStart(from).getTime()) / DAY_MS) + 1
    );
    const dailyAverage = Math.round((items / spanDays) * 10) / 10;

    // Current streak: consecutive active days ending TODAY or YESTERDAY.
    // Yesterday counts on purpose — it is 9am somewhere and a streak that dies
    // because you have not read yet today is a streak that punishes the user
    // for the clock rather than for stopping.
    const active = new Set(buckets.keys());
    const yesterdayKey = shiftDay(todayKey, -1);
    let cursor: string | null = active.has(todayKey)
      ? todayKey
      : active.has(yesterdayKey)
        ? yesterdayKey
        : null;
    let currentStreak = 0;
    while (cursor && active.has(cursor)) {
      currentStreak++;
      cursor = shiftDay(cursor, -1);
    }

    // Best streak: longest consecutive run anywhere in the range.
    let bestStreak = 0;
    let run = 0;
    let prev: string | null = null;
    for (const d of dayList) {
      run = prev !== null && shiftDay(prev, 1) === d.date ? run + 1 : 1;
      if (run > bestStreak) bestStreak = run;
      prev = d.date;
    }

    res.json({
      success: true,
      data: {
        days: dayList,
        totals: { items, episodes, chapters, dailyAverage, currentStreak, bestStreak },
        // `timezone` is not decoration: it tells the client these keys are
        // already UTC days and must be rendered, not re-derived.
        range: { from, to: todayKey, days: spanDays, timezone: "UTC" },
        // True only when the row cap bit. `range.from` has already been moved
        // up to the first fully-counted day, so the numbers are right for the
        // range stated — this flag just says the range is shorter than asked.
        truncated,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/users/:id/activity/:date ──────────────────────────────────────

/** What a batched lookup contributes. Titles are nullable on NovelBookmark. */
interface Resolved {
  title: string | null;
  cover: string | null;
}

/**
 * One UTC day, expanded into readable rows.
 *
 * Budget: one PointLog query plus AT MOST three batched lookups (one per
 * library, skipped entirely when that library contributed no ids). Never a
 * query per item — a 50-item day would otherwise be 51 round trips.
 */
export const getUserActivityDay = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.id as string;
    const date = String(req.params.date || "");

    if (!isDayKey(date)) {
      return res.status(400).json({ success: false, message: "Date must be YYYY-MM-DD." });
    }

    const start = dayStart(date);
    const end = new Date(start.getTime() + DAY_MS); // [start, end) — one UTC day

    const rows = await prisma.pointLog.findMany({
      where: {
        userId,
        createdAt: { gte: start, lt: end },
        OR: ACTIVITY_REASON_FILTER,
      },
      select: { reason: true, createdAt: true }, // never `amount`
      orderBy: { createdAt: "desc" },
      take: DAY_ROW_CAP,
    });

    // Counts come from every row; the ITEM list is capped. Newest-first means
    // the 50 shown are the 50 most recent, and `episodes`/`chapters` still
    // agree with the same day's numbers in the range endpoint above.
    let episodes = 0;
    let chapters = 0;
    const itemRows: ParsedActivity[] = [];
    for (const row of rows) {
      const parsed = parseActivityReason(row.reason);
      if (!parsed) continue;
      if (parsed.kind === "anime") episodes++;
      else chapters++;
      if (itemRows.length < DAY_ITEM_CAP) itemRows.push(parsed);
    }

    // Ids only for what is actually rendered.
    const animeIds = Array.from(
      new Set(
        itemRows
          .filter((p) => p.kind === "anime")
          .map((p) => Number(p.id))
          // WatchlistItem.anilistId is an Int — a non-numeric id can't be
          // looked up, so it goes straight to the fallback title instead.
          .filter((n) => Number.isInteger(n))
      )
    );
    const mangaIds = Array.from(new Set(itemRows.filter((p) => p.kind === "manhwa").map((p) => p.id)));
    const novelIds = Array.from(new Set(itemRows.filter((p) => p.kind === "novel").map((p) => p.id)));

    // Best-effort resolution from what this user already tracks. Each lookup is
    // skipped when its id list is empty, so a pure-reading day never touches
    // the watchlist table.
    const [watchRows, manhwaRows, novelRows] = await Promise.all([
      animeIds.length
        ? prisma.watchlistItem.findMany({
            where: { userId, anilistId: { in: animeIds } },
            select: { anilistId: true, title: true, coverImage: true },
          })
        : Promise.resolve([] as { anilistId: number; title: string; coverImage: string | null }[]),
      mangaIds.length
        ? prisma.manhwaBookmark.findMany({
            where: { userId, mangaId: { in: mangaIds } },
            select: { mangaId: true, title: true, coverImage: true },
          })
        : Promise.resolve([] as { mangaId: string; title: string; coverImage: string | null }[]),
      novelIds.length
        ? prisma.novelBookmark.findMany({
            where: { userId, novelId: { in: novelIds } },
            select: { novelId: true, title: true, coverImage: true },
          })
        : Promise.resolve([] as { novelId: string; title: string | null; coverImage: string | null }[]),
    ]);

    const animeById = new Map<string, Resolved>();
    for (const r of watchRows) animeById.set(String(r.anilistId), { title: r.title, cover: r.coverImage });
    const manhwaById = new Map<string, Resolved>();
    for (const r of manhwaRows) manhwaById.set(r.mangaId, { title: r.title, cover: r.coverImage });
    const novelById = new Map<string, Resolved>();
    for (const r of novelRows) novelById.set(r.novelId, { title: r.title, cover: r.coverImage });

    const items = itemRows.map((p) => {
      const hit =
        p.kind === "anime"
          ? animeById.get(p.id)
          : p.kind === "manhwa"
            ? manhwaById.get(p.id)
            : novelById.get(p.id);
      return {
        type: p.kind,
        // A missing cover NEVER drops the entry — cover is simply null and the
        // client draws its placeholder.
        title: (hit?.title || "").trim() || fallbackTitle(p),
        cover: hit?.cover || null,
        label: unitLabel(p),
        href: activityHref(p),
      };
    });

    res.json({
      success: true,
      data: {
        date,
        episodes,
        chapters,
        items,
        timezone: "UTC",
        // Only if a single day somehow blew past DAY_ROW_CAP rows.
        truncated: rows.length >= DAY_ROW_CAP,
      },
    });
  } catch (error) {
    next(error);
  }
};
