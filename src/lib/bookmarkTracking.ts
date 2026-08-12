/**
 * LIBRARY MEMBERSHIP vs. READING PROGRESS — the rule, defined exactly once.
 *
 * A ManhwaBookmark / NovelBookmark row used to mean one thing: "this member put
 * this title on their shelf." Cross-device progress sync broke that. POST
 * /progress upserts on the same row, so opening a single chapter of anything
 * CREATES one — and that row is what the public profile payload renders. One
 * chapter of anything published it to a public shelf.
 *
 * `trackedAt` splits the two meanings apart:
 *   set   → the reader deliberately added the title (POST /, or a PATCH that
 *           sets a status). Library membership. Public.
 *   unset → a progress-only pointer written by POST /progress. Private. The
 *           client still needs it (that's where lastChapterId lives), so the
 *           bookmark GETs keep returning it — the PROFILE payload is what must
 *           exclude it.
 *
 * ── WHY THIS IS A FUNCTION AND NOT `trackedAt != null` ─────────────────────
 *
 * Every row written before this column existed was created by a genuine add —
 * the only writer at the time was the add endpoint — and every one of them has
 * trackedAt NULL. A bare NULL check would therefore read every pre-existing
 * library on the site as empty. That is a far worse failure than the bug being
 * fixed: the progress-row leak is a title showing up that shouldn't, and it is
 * self-healing (the member can remove it); an emptied shelf is destroyed data
 * from the member's point of view, with no path back.
 *
 * So the rule is deliberately BIASED TOWARD KEEPING A SHELF INTACT. A row
 * counts as tracked when ANY of these hold:
 *
 *   1. trackedAt is set          — stated outright by an add. Unambiguous.
 *   2. createdAt < LEGACY_CUTOFF — predates this column, so it predates the
 *                                  progress writer's ability to create rows on
 *                                  the shelf's behalf. It was an add.
 *   3. lastChapterId is NULL     — STRUCTURAL proof: POST /progress rejects a
 *                                  request without a chapterId and always
 *                                  writes it, so a row that has never carried a
 *                                  chapter pointer cannot have been born from a
 *                                  progress ping. Something deliberate made it.
 *
 * Clauses 2 and 3 only ever ADD to the tracked set, never remove from it, and
 * neither can rescue a real progress-only row created after the cutoff (those
 * always carry lastChapterId). So B1 is fully closed going forward while no
 * existing shelf can be emptied by this change.
 *
 * BACKFILL: there is deliberately no write. Clause 2 IS the backfill, evaluated
 * at read time. A one-shot updateMany would have had to guess the deploy
 * instant, and guessing it EARLY — the easy mistake — permanently blanks every
 * genuine add made between the guess and the real deploy, with the evidence
 * already overwritten. This version writes nothing, so a wrong cutoff is a
 * one-line correction rather than data loss. Rows also self-migrate: any add or
 * status change on a legacy row materializes its effective value into the
 * column (see the routes), so the legacy clauses fade out on their own.
 */

/**
 * Just before this shipped. Rows created earlier predate the column and count
 * as genuine adds; everything after is stamped explicitly by the add paths.
 *
 * THE CUTOFF MUST NOT SIT IN THE FUTURE. It is tempting to date it to the end
 * of the shipping day "to be safe", and that reasoning is exactly backwards:
 * POST /progress does not exist in production until this deploy, so no
 * progress-only row can predate the cutoff — there is no existing leak to
 * prolong. A future date instead OPENS one, classifying every progress-only
 * row created between deploy and that date as library membership and
 * publishing it to the reader's public shelf. That is the precise bug this
 * file exists to prevent.
 *
 * The cost of erring early is a genuine add made in the minutes between this
 * timestamp and the deploy going untracked — invisible on the shelf until the
 * member touches that title again, at which point the add paths stamp it.
 * Losing a few minutes of shelf visibility is recoverable; publishing what
 * somebody reads is not.
 */
export const TRACKED_LEGACY_CUTOFF = new Date("2026-08-12T17:55:00.000Z");

/** The shape both bookmark models share, as far as this rule is concerned. */
export interface TrackableBookmark {
  trackedAt: Date | null;
  createdAt: Date;
  lastChapterId: string | null;
}

/**
 * The Prisma `where` that keeps ONLY rows the member actually put on their
 * shelf. Use this anywhere bookmarks are exposed as library membership — above
 * all the public profile payload. Returns a fresh literal per call so no caller
 * can mutate the shared rule.
 */
export function trackedBookmarkFilter() {
  return {
    OR: [
      { trackedAt: { not: null } },
      { createdAt: { lt: TRACKED_LEGACY_CUTOFF } },
      { lastChapterId: null },
    ],
  };
}

/**
 * The value a row's `trackedAt` SHOULD carry — the same rule as the filter,
 * for a row already in hand. Non-null means "in the library"; null means
 * "progress-only pointer". Legacy rows answer with their createdAt, which is
 * the honest moment they entered the library.
 *
 * Every bookmark row leaving this API is passed through here, so a client can
 * trust `trackedAt != null` even though the raw column can't be trusted yet.
 */
export function effectiveTrackedAt(row: TrackableBookmark): Date | null {
  if (row.trackedAt) return row.trackedAt;
  if (row.createdAt < TRACKED_LEGACY_CUTOFF) return row.createdAt;
  if (row.lastChapterId === null) return row.createdAt;
  return null;
}

/**
 * Normalizes a row for the wire: same row, with `trackedAt` resolved to its
 * effective value. Used by every endpoint in the two bookmark routers.
 */
export function withEffectiveTrackedAt<T extends TrackableBookmark>(
  row: T
): T & { trackedAt: Date | null } {
  return { ...row, trackedAt: effectiveTrackedAt(row) };
}
