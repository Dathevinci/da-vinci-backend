/**
 * Totals for the explore/browse endpoints — one rule, stated once.
 *
 * A numbered pager needs to know how many pages there are, and the sources
 * behind this app do not all report one. The contract that keeps that honest:
 *
 *   A TOTAL IS ONLY EVER SENT WHEN THE UPSTREAM ACTUALLY PUBLISHED ONE.
 *
 * `totalPages` and `totalItems` are OPTIONAL and simply ABSENT when unknown —
 * never 0, never 1. "We don't know" and "there is exactly one page" are
 * different facts and the client has to tell them apart: one draws real page
 * numbers, the other draws a plain Prev/Next. A fabricated total is worse than
 * no total, because the reader clicks page 43, lands on nothing, and no code
 * downstream can tell that the number was a guess.
 *
 * `hasNextPage` is untouched by any of this. It is what infinite scroll rides
 * on, it means "the SOURCE has another page", and it must keep meaning exactly
 * that — it is never derived from how many rows survived our own filtering.
 */

export interface PageTotals {
  /** Last page the reader can actually ask for. Absent = the source never said. */
  totalPages?: number;
  /** How many items exist in total. Absent = unknown. */
  totalItems?: number;
  /** Set when the numbers are a bound rather than a count — render as "N+". */
  totalsApproximate?: boolean;
}

/**
 * AniList's ceiling on how deep a result set may be paged: its pageInfo reports
 * at most total 5000 / lastPage 250 however many entries really match.
 */
const ANILIST_TOTAL_CAP = 5000;

/**
 * AniList `Page.pageInfo` → the totals contract.
 *
 * AniList publishes `lastPage` and `total` outright, and for anything but the
 * widest queries they are exact — measured against the live API: search
 * "frieren" answers total 6 / lastPage 1, and season WINTER 2024 + genre Mecha
 * answers total 4 / lastPage 1. Those are real page numbers, not estimates.
 *
 * The exception is the cap. An unfiltered browse answers total 5000 / lastPage
 * 250 regardless of the true size, because that is where AniList stops
 * counting. 250 is still the deepest page a reader can reach, so it remains the
 * right number to page to — but it is a ceiling rather than a census, and
 * presenting it as exact would be the same class of lie as inventing it. That
 * case alone is flagged approximate.
 */
export function anilistTotals(pageInfo: unknown): PageTotals {
  const info = pageInfo as { total?: unknown; lastPage?: unknown } | null | undefined;
  const total = Number(info?.total);
  const lastPage = Number(info?.lastPage);

  if (!Number.isFinite(lastPage) || lastPage <= 0) return {};
  if (!Number.isFinite(total) || total <= 0) return { totalPages: lastPage };

  return total >= ANILIST_TOTAL_CAP
    ? { totalPages: lastPage, totalItems: total, totalsApproximate: true }
    : { totalPages: lastPage, totalItems: total };
}

/** Pull `Page.pageInfo` out of an AniList payload without assuming its shape. */
export function pageInfoOf(data: unknown): unknown {
  return (data as { Page?: { pageInfo?: unknown } } | null | undefined)?.Page?.pageInfo;
}
