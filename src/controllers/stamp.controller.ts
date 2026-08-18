import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
// The week key is IMPORTED, not re-implemented. The stamp board and the gem
// board have to bucket into identical weeks ("2026-W31"), and two copies of an
// ISO-week calculation drift at exactly the place ISO weeks are hard — the
// turn of the year. One function, one answer.
import { weekKey } from "./gem.controller";

/**
 * THE STAMP SYSTEM — a curation reputation.
 *
 * One global stamp per member, three ACTIVE recommendations at a time. The
 * people who follow you see them; they give an explicit thumbs up or down; the
 * verdict moves your stamp's grade. Others can spend Arise Points to lift it.
 *
 * Nothing here is stored as a score. grade/score/organic/boosted are derived
 * from StampRec + StampVote + StampBoost on every read — see the schema
 * comment for why a denormalised column was rejected.
 *
 * The four rules that carry the whole design:
 *
 *  1. THE VOTE GATE. A StampVote may only be written when a StampRecOpen row
 *     exists for (voter, rec) — i.e. that person actually opened the thing.
 *     It's still a plain thumbs up/down, it just can't come from someone who
 *     never clicked through. This is the anti-brigade guarantee. It is backed
 *     by the DB uniqueness on (recId, userId) — one person, one verdict — and
 *     by the hard identity gate below, WITHOUT WHICH BOTH ARE DECORATIVE.
 *
 *  2. RETIRING DOESN'T ERASE THE VERDICT, BUT IT DOES CLOSE THE REC.
 *     `organic` sums damped scores over ACTIVE AND RETIRED recs alike —
 *     implemented by never joining StampRec in the aggregation at all, since
 *     StampVote carries its own ownerId — so a bad call cannot be laundered by
 *     pulling the recommendation down. What retirement DOES stop is new
 *     traffic: a retired rec is listed by no endpoint, so it can neither be
 *     found nor counter-voted, which made it a private one-way score channel
 *     while open/vote still accepted writes. Both now refuse it.
 *
 *  3. A TITLE IS STAMPED ONCE, EVER. The duplicate check spans retired recs
 *     too. Otherwise retire-and-re-stamp mints a fresh rec id — and therefore
 *     a fresh vote slate, since StampVote is unique per (rec, user) — for the
 *     same title and the same friend group, without limit.
 *
 *  4. BOOSTS ARE HONEST. Each booster's contribution is
 *     floor(sqrt(their total AP to this stamp)) — diminishing returns PER
 *     BOOSTER, so a second wallet buys far less than the first — and the total
 *     boost is capped at the earned score, so nobody buys a grade from zero.
 *     `organic` and `boosted` are returned separately and always displayed
 *     separately: a stamp shows what it earned and what it was given.
 */

// ── Tunables ───────────────────────────────────────────────────────────────

const MEDIA_TYPES = new Set(["anime", "manhwa", "novel"]);

/** Active recommendation slots. Also hard-enforced by @@unique([ownerId, slot]). */
const MAX_ACTIVE = 3;

/**
 * Votes needed before a recommendation's verdict counts at full weight. Below
 * this the score is scaled down, so one friend's lone thumbs-up is worth a
 * fraction of a point rather than a whole one, and a single early downvote
 * can't tank a rec nobody has read yet.
 */
const VOTE_FULL_WEIGHT = 5;

const FEED_LIMIT = 60;

/**
 * Rows on one page of the site-wide recent feed.
 *
 * Fixed by contract at 30 rather than read from a `limit` query param: this is
 * a public, unauthenticated read over every member's recommendations, and a
 * caller-chosen page size on such a read is a free lever for turning one
 * request into a site-wide scan. The client asks for the NEXT page, never for a
 * bigger one.
 */
const RECENT_PAGE = 30;

/**
 * Ceiling on how many stampers of ONE title are answered at once.
 *
 * A title's stamper list is naturally bounded — a member carries MAX_ACTIVE
 * recommendations and a title is stamped once per member ever — so this is a
 * runaway guard, not a paging mechanism; there is deliberately no cursor here
 * because the client draws the whole row of faces at once. If it is ever
 * reached, see getStampersFor: the cut is by newest, which could drop a podium
 * curator, so the podium's own copies are merged back in.
 */
const STAMPERS_LIMIT = 200;

/**
 * Rows on one weekly board page.
 *
 * A hundred, not the original twenty-five, because the board is the shop window
 * for the prize: the top three wear their seal on every cover they recommend,
 * site-wide, and a deep board is what makes rank 40 feel like a climb toward
 * that instead of a wall. The page costs no extra site-wide scan — the ranked
 * board behind it is computed and cached whole regardless of where it is
 * sliced, and the three follow-up reads are all scoped to the ids on the page.
 */
const BOARD_LIMIT = 100;

const MAX_BLURB = 400;
const MAX_TITLE = 300;
const MAX_ID = 300;
const MAX_COVER = 600;

/**
 * How long one computed weekly board stays warm.
 *
 * A board is a site-wide scan of a week's votes and boosts; the profile, the
 * feed and the board page all want the SAME two boards (this week for ranks,
 * last week for the seals). Recomputing per request multiplied that scan by
 * traffic — a single /stamps render used to pay for ~32 of them. Thirty
 * seconds is long enough that a burst of profile views costs one aggregation
 * instead of one each, and short enough that a rank nobody explicitly moved
 * still settles within half a minute. Writes that DO move a rank invalidate
 * their own week immediately (see invalidateBoard), so the person who voted
 * never sees their own action lag.
 */
const BOARD_TTL_MS = 30_000;

/** Week keys kept warm at once — enough for this week, last week, and a few
 *  history pages being browsed; past that the oldest stale entries are swept. */
const BOARD_CACHE_MAX = 8;

/**
 * How long the site-wide endorsement set stays warm.
 *
 * Ten times the board's window because this one is asked for by EVERY browsing
 * session, once, to decorate covers — the highest-traffic read in the system
 * and the one whose answer changes least. Its inputs move only when a podium
 * curator swaps a recommendation (which invalidates explicitly, right at the
 * write) or when the ISO week turns (which changes the cache key). Five minutes
 * is therefore a backstop for drift nobody triggered — a podium member's
 * lifetime grade creeping a band on someone else's vote — not the mechanism
 * that keeps the payload correct.
 */
const ENDORSEMENT_TTL_MS = 5 * 60_000;

// ── Score math ─────────────────────────────────────────────────────────────

/**
 * One recommendation's contribution.
 *
 * raw = up - down, then damped by the confidence factor described at
 * VOTE_FULL_WEIGHT. Math.trunc rather than round/floor because the spec is
 * "round toward zero": a -0.4 must become 0, not -1, or an unread rec with a
 * single downvote would cost a full point.
 */
function dampedScore(up: number, down: number): number {
  const raw = up - down;
  const confidence = Math.min(1, (up + down) / VOTE_FULL_WEIGHT);
  return Math.trunc(raw * confidence);
}

/**
 * One booster's contribution to a stamp: floor(sqrt(everything they have ever
 * sent it)). Note the SUM happens before the sqrt — ten sends of 100 AP are
 * worth sqrt(1000), not 10 * sqrt(100). Splitting a boost into instalments
 * must never beat sending it at once, or the curve buys nothing.
 */
function boosterCurve(totalAp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, totalAp)));
}

/** Grade bands. Below zero is D — a stamp can be worse than unproven. */
function gradeFor(score: number): string {
  if (score < 0) return "D";
  if (score < 10) return "C";
  if (score < 30) return "B";
  if (score < 75) return "A";
  if (score < 150) return "S";
  if (score < 300) return "SS";
  return "SSS";
}

/**
 * The headroom every stamp has before it has earned anything.
 *
 * Without it the system cold-starts locked: boosted is capped at what a stamp
 * EARNED, so on day one — nobody voted yet, every organic is 0 — the ceiling
 * was 0 for everyone and Arise Points could not move a single grade. The
 * feature existed and did nothing, which is exactly how it was reported.
 *
 * 25 is deliberately small: it is the B band's floor (10) with room to spare
 * but nowhere near A (30), so a stamp nobody has ever voted on can be lifted
 * to "promising" and no further. Everything above that still has to be earned.
 */
const BOOST_FLOOR = 25;

/**
 * Fold the earned and the bought halves into a stamp.
 *
 * boosted is capped at max(BOOST_FLOOR, organic): purchased score can at most
 * DOUBLE what a stamp earned once it is earning, and before that it is bounded
 * by the floor above. The cap applies to the summed curve, not per booster, so
 * pooling many wallets does not escape it either.
 *
 * A NEGATIVE organic still gets the floor rather than zero headroom. That is a
 * conscious trade: it means a net-downvoted curator can be supported back to a
 * modest grade, which is a bounded 25 points of forgiveness rather than a way
 * to buy a reputation.
 */
function combine(organic: number, boostRaw: number) {
  const boosted = Math.min(boostRaw, Math.max(BOOST_FLOOR, organic));
  const score = organic + boosted;
  return { organic, boosted, score, grade: gradeFor(score) };
}

// ── Aggregation (all of these are constant-query — no N+1) ─────────────────

interface RecTally {
  up: number;
  down: number;
}

/**
 * Which stamps an aggregation covers.
 *
 * A concrete list of ids is the normal case. "ALL" is the unfiltered, site-wide
 * scan that ONLY the weekly board is allowed to want, and it has to be asked
 * for by that name. The previous signature inferred it from an empty array,
 * which meant any caller whose id list happened to come back empty — a feed
 * with no owners, a board page with no rows — silently escalated into a groupBy
 * over the entire vote table. The scan is correct for the board and
 * catastrophic everywhere else, so it can no longer happen by accident.
 */
type StampScope = string[] | "ALL";

/**
 * ONE groupBy that answers both "how did each rec do" and "what is each
 * owner's organic score".
 *
 * by [ownerId, recId, value] gives every (rec, direction) bucket with a count,
 * which is everything the damping formula needs. Crucially it reads StampVote
 * ONLY — StampRec is never joined — so retired recommendations keep counting
 * without any special case, and the query cost does not grow with the number
 * of recs a member has.
 *
 * `week` narrows the same aggregation to one ISO week for the weekly board.
 */
async function tallyVotes(scope: StampScope, week?: string) {
  const perRec = new Map<string, RecTally>();
  const perOwner = new Map<string, number>();
  const recOwner = new Map<string, string>();

  if (scope === "ALL" && !week) {
    // Unreachable by construction — weekBoard is the only "ALL" caller and it
    // always has a week. Thrown rather than silently run: an all-time scan of
    // every vote ever cast is never what anybody meant.
    throw new Error("tallyVotes('ALL') requires a week.");
  }
  if (scope !== "ALL" && scope.length === 0) return { perRec, perOwner };

  const groups = await prisma.stampVote.groupBy({
    by: ["ownerId", "recId", "value"],
    where: {
      ...(scope === "ALL" ? {} : { ownerId: { in: scope } }),
      ...(week ? { week } : {}),
    },
    _count: { _all: true },
  });

  for (const g of groups) {
    const tally = perRec.get(g.recId) || { up: 0, down: 0 };
    if (g.value > 0) tally.up += g._count._all;
    else tally.down += g._count._all;
    perRec.set(g.recId, tally);
    recOwner.set(g.recId, g.ownerId);
  }

  // Damping is PER REC, so the fold has to happen after every bucket of a rec
  // has been seen — summing as we go would apply the confidence factor to
  // partial counts.
  for (const [recId, tally] of perRec) {
    const owner = recOwner.get(recId)!;
    perOwner.set(owner, (perOwner.get(owner) || 0) + dampedScore(tally.up, tally.down));
  }

  return { perRec, perOwner };
}

/**
 * ONE groupBy for boosts: each (stamp, booster) pair's running total, curved
 * and summed per stamp. Grouping by the pair is what makes the diminishing
 * return PER BOOSTER rather than per payment. Same "ALL" rule as tallyVotes.
 */
async function tallyBoosts(scope: StampScope, week?: string): Promise<Map<string, number>> {
  const perStamp = new Map<string, number>();

  if (scope === "ALL" && !week) throw new Error("tallyBoosts('ALL') requires a week.");
  if (scope !== "ALL" && scope.length === 0) return perStamp;

  const groups = await prisma.stampBoost.groupBy({
    by: ["stampUserId", "boosterId"],
    where: {
      ...(scope === "ALL" ? {} : { stampUserId: { in: scope } }),
      ...(week ? { week } : {}),
    },
    _sum: { amount: true },
  });

  for (const g of groups) {
    perStamp.set(g.stampUserId, (perStamp.get(g.stampUserId) || 0) + boosterCurve(g._sum.amount || 0));
  }
  return perStamp;
}

/** All-time stamp for one member, in two queries. */
async function stampTotals(userId: string) {
  const [votes, boosts] = await Promise.all([tallyVotes([userId]), tallyBoosts([userId])]);
  return combine(votes.perOwner.get(userId) || 0, boosts.get(userId) || 0);
}

interface BoardRow {
  userId: string;
  weekScore: number;
  /** The week's earned half — NOT the lifetime one. Named for its timeframe on
   *  purpose: the row that reaches the client must never let a reader take an
   *  all-time split for the breakdown of a weekly number. */
  weekOrganic: number;
  weekBoosted: number;
}

interface RankedRow extends BoardRow {
  rank: number;
}

/**
 * The weekly board: the score EARNED INSIDE one ISO week, not all-time.
 *
 * A newcomer's first good week beats a veteran's dormant one, which is the
 * whole point — an all-time board freezes on week two and stops being worth
 * looking at. Same math as the lifetime score, run over only that week's votes
 * and boosts, so the boost cap still applies within the week and a big spend
 * on a stamp that earned nothing that week still buys nothing.
 *
 * THE RANK IS ASSIGNED HERE AND NOWHERE ELSE. A profile's weeklyRank and a
 * board row's rank used to be two computations over the same data — the board
 * dropped deleted accounts and renumbered, the profile read a raw index — so
 * the same member could be told "rank 5" on their profile while the board they
 * were looking at printed 4. Dropping happens BEFORE numbering (and therefore
 * before any caller slices to a page limit, which is also what stops a
 * BOARD_LIMIT-row page from coming back one row short).
 */
async function computeRankedBoard(week: string): Promise<RankedRow[]> {
  const [votes, boosts] = await Promise.all([tallyVotes("ALL", week), tallyBoosts("ALL", week)]);

  const ids = new Set<string>([...votes.perOwner.keys(), ...boosts.keys()]);
  const rows: BoardRow[] = [];
  for (const userId of ids) {
    const { score, organic, boosted } = combine(votes.perOwner.get(userId) || 0, boosts.get(userId) || 0);
    rows.push({ userId, weekScore: score, weekOrganic: organic, weekBoosted: boosted });
  }
  if (rows.length === 0) return [];

  // Ties break on userId so the ordering — and therefore the ranks and the
  // top-three seals — is stable between two reads of the same week.
  rows.sort((a, b) => b.weekScore - a.weekScore || a.userId.localeCompare(b.userId));

  // Defensive: every stamp row cascades from User, so an orphan should be
  // impossible. Kept because rank is a promise to the reader — a number that
  // silently skips is worse than one query — and it is paid once per cache
  // window, not once per request.
  const live = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.userId) } },
    select: { id: true },
  });
  const alive = new Set(live.map((u) => u.id));

  return rows.filter((r) => alive.has(r.userId)).map((row, i) => ({ ...row, rank: i + 1 }));
}

/**
 * The warm board cache. Keyed by week; the PROMISE is stored rather than the
 * resolved rows so that a burst of concurrent readers collapses onto one
 * aggregation instead of all starting their own.
 */
const boardCache = new Map<string, { at: number; rows: Promise<RankedRow[]> }>();

function rankedBoard(week: string): Promise<RankedRow[]> {
  const hit = boardCache.get(week);
  if (hit && Date.now() - hit.at < BOARD_TTL_MS) return hit.rows;

  const rows = computeRankedBoard(week).catch((e) => {
    // A failed board must not be served for the rest of the window.
    boardCache.delete(week);
    throw e;
  });
  boardCache.set(week, { at: Date.now(), rows });

  if (boardCache.size > BOARD_CACHE_MAX) {
    // Someone browsing back through history would otherwise leave one array per
    // week key resident for the life of the process.
    const now = Date.now();
    for (const [k, v] of boardCache) {
      if (k !== week && now - v.at >= BOARD_TTL_MS) boardCache.delete(k);
    }
  }
  return rows;
}

/** Drop a week's cached board — called by the writes that can move a rank, so
 *  the member who just voted or boosted sees their own effect immediately. */
function invalidateBoard(week: string): void {
  boardCache.delete(week);
}

/** The ISO week key seven days back — last week's board, whose top 3 wear seals. */
function lastWeekKey(): string {
  return weekKey(new Date(Date.now() - 7 * 86400000));
}

/**
 * The seal a member wears RIGHT NOW: last week's podium, worn through the
 * current week. Reading the live board instead would make the top three
 * flicker all week. Bounded to three entries; the board behind it is cached.
 */
async function wornPodium(): Promise<Map<string, 1 | 2 | 3>> {
  const rows = await rankedBoard(lastWeekKey());
  const podium = new Map<string, 1 | 2 | 3>();
  for (const r of rows.slice(0, 3)) podium.set(r.userId, r.rank as 1 | 2 | 3);
  return podium;
}

// ── Site-wide endorsements ─────────────────────────────────────────────────

/**
 * THE PRIZE. The podium's picks wear their curator's seal on the cover of the
 * title EVERYWHERE it appears — browse grids, carousels, detail pages — and the
 * seal taps through to that curator's profile. That tap is the whole reward:
 * it is how a week at the top converts into followers.
 *
 * WHAT MAKES IT AFFORDABLE IS ITS SIZE, AND THE SIZE IS STRUCTURAL. A stamp
 * carries at most MAX_ACTIVE recommendations and exactly three curators wear a
 * seal, so the ENTIRE site-wide endorsement set is at most nine rows. That is
 * why this is one tiny document fetched once per session and indexed by media
 * id on the client — never a per-card request, and never a join bolted onto a
 * browse query, which is what a "which cards are endorsed" flag would have
 * become had it been modelled on the card instead of here.
 *
 * Only the fields a cover actually draws are on the row. No blurb, no vote
 * counts, no rec id: everything a reader wants beyond the seal is one tap away
 * on the profile the seal already links to, and this payload is on the critical
 * path of every browse render.
 */
type Endorsement = {
  mediaType: string;
  mediaId: string;
  ownerId: string;
  ownerUsername: string;
  ownerAvatar: string | null;
  /** Lifetime grade — the same letter the seal shows everywhere else. A grade
   *  that reset with the weekly board would not be a reputation. */
  ownerGrade: string;
  /** Last week's podium place. Never null here: off-podium curators produce no
   *  rows at all, so the client can draw the crown unconditionally. */
  ownerRank: 1 | 2 | 3;
};

async function computeEndorsements(week: string): Promise<Endorsement[]> {
  const podium = (await rankedBoard(week)).slice(0, 3);
  if (podium.length === 0) return [];

  const ids = podium.map((r) => r.userId);
  const rankOf = new Map(podium.map((r) => [r.userId, r.rank as 1 | 2 | 3]));

  // Four constant queries, all scoped to three ids — never "ALL". Retired recs
  // are excluded by the same rule that hides them from every other endpoint: a
  // pick that was pulled down must stop advertising, and a seal on a cover is
  // the loudest advertising in the system.
  const [recs, users, votes, boosts] = await Promise.all([
    prisma.stampRec.findMany({
      where: { ownerId: { in: ids }, retiredAt: null },
      select: { ownerId: true, mediaType: true, mediaId: true, createdAt: true },
    }),
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true, avatar: true },
    }),
    tallyVotes(ids),
    tallyBoosts(ids),
  ]);

  const byId = new Map(users.map((u) => [u.id, u]));
  const gradeOf = new Map<string, string>();
  for (const id of ids) {
    gradeOf.set(id, combine(votes.perOwner.get(id) || 0, boosts.get(id) || 0).grade);
  }

  // Best rank first. Two podium curators CAN stamp the same title — the
  // stamped-once rule is per member, not global — and a cover draws one seal,
  // so the order decides which. Sorting here means the client resolves a
  // collision by keeping the first row it sees rather than re-deriving the
  // precedence rule on every card.
  return recs
    .filter((rec) => byId.has(rec.ownerId))
    .sort(
      (a, b) =>
        rankOf.get(a.ownerId)! - rankOf.get(b.ownerId)! ||
        b.createdAt.getTime() - a.createdAt.getTime()
    )
    .map((rec) => {
      const user = byId.get(rec.ownerId)!;
      return {
        mediaType: rec.mediaType,
        mediaId: rec.mediaId,
        ownerId: rec.ownerId,
        ownerUsername: user.username,
        ownerAvatar: user.avatar,
        ownerGrade: gradeOf.get(rec.ownerId) || gradeFor(0),
        ownerRank: rankOf.get(rec.ownerId)!,
      };
    });
}

/**
 * The warm endorsement set. Same shape as boardCache and for the same reason:
 * the PROMISE is stored, not the resolved rows, so the burst of readers that
 * arrives when a page of covers renders collapses onto one computation instead
 * of each starting its own.
 */
const endorsementCache = new Map<string, { at: number; rows: Promise<Endorsement[]> }>();

/**
 * Returns the podium week alongside the rows so the two can never disagree —
 * reading lastWeekKey() twice around an await could straddle the week turn and
 * label one podium with the other's week.
 */
function endorsements(): { week: string; rows: Promise<Endorsement[]> } {
  const week = lastWeekKey();
  const hit = endorsementCache.get(week);
  if (hit && Date.now() - hit.at < ENDORSEMENT_TTL_MS) return { week, rows: hit.rows };

  const rows = computeEndorsements(week).catch((e) => {
    // A failed computation must not be served warm for the rest of the window.
    endorsementCache.delete(week);
    throw e;
  });
  // Only the current podium week is ever requested, so the previous key is dead
  // the instant the week turns — cleared outright rather than swept on a size
  // bound like boardCache, which genuinely serves several weeks at once.
  endorsementCache.clear();
  endorsementCache.set(week, { at: Date.now(), rows });
  return { week, rows };
}

/** Drop the warm endorsement set — called by the podium's own writes, so a
 *  curator swapping a pick sees their seal move rather than waiting out a TTL
 *  measured in minutes. */
function invalidateEndorsements(): void {
  endorsementCache.clear();
}

// ── Identity ───────────────────────────────────────────────────────────────

/**
 * EVERY STATE-CHANGING STAMP ENDPOINT TAKES ITS ACTOR FROM THE TOKEN ONLY.
 *
 * The precedent is gem.controller.castGemVote, not auction.controller's
 * placeBid. auction can afford a soft posture because a forged bid spends the
 * VICTIM'S points on an item the victim receives; here a forged vote costs the
 * attacker nothing and is pure gain, and a forged boost converts someone
 * else's balance into the attacker's own grade — including past the
 * "can't boost your own stamp" rule, whose only enforcement was a string
 * comparison the attacker chose both sides of. /rankings publishes userIds by
 * contract, so the ids needed are harvestable from this very API.
 *
 * There is no grandfathering to protect: the stamp system is brand new, so no
 * pre-JWT session holds a stamp it could lose. Strict from birth costs nothing.
 *
 * A userId/boosterId may still ride along in the body — the existing clients
 * send it — but it never DECIDES anything. It is only compared: disagreeing
 * with the token is 403, absent is fine, and the token's id is what gets
 * written either way.
 *
 * Responds and returns null when the caller isn't proven; the caller returns.
 */
function actorFor(req: Request, res: Response, claimed?: unknown): string | null {
  const actor = getActorId(req);
  if (!actor) {
    res.status(401).json({
      success: false,
      code: "AUTH_REQUIRED",
      message: "Sign in to use your stamp.",
    });
    return null;
  }
  const claimedId = typeof claimed === "string" ? claimed.trim() : "";
  if (claimedId && claimedId !== actor) {
    res.status(403).json({
      success: false,
      code: "IDENTITY_MISMATCH",
      message: "That request is signed by a different account.",
    });
    return null;
  }
  return actor;
}

/**
 * Who is READING. Reads stay soft: they hand out nothing that isn't public
 * except the reader's own vote/open state, so a missing token degrades to
 * "anonymous" rather than 401.
 *
 * The ?viewer=/?userId= fallback is what a client without a stored JWT sends to
 * get its own myVote/opened back. It grants no write power — every write above
 * is token-only — so trusting it here is worth exactly the personalisation it
 * buys and nothing more.
 */
function viewerOf(req: Request, queryKey: string = "viewer"): string | null {
  const fromToken = getActorId(req);
  if (fromToken) return fromToken;
  const fromQuery = String(req.query[queryKey] || "").trim();
  return fromQuery || null;
}

// ── Serialisation ──────────────────────────────────────────────────────────

type RecRow = {
  id: string;
  ownerId: string;
  mediaType: string;
  mediaId: string;
  title: string;
  cover: string | null;
  blurb: string | null;
  createdAt: Date;
  retiredAt: Date | null;
};

type OwnerRow = { id: string; username: string; avatar: string | null };

/**
 * The owner's stamp identity, carried ON the rec.
 *
 * This exists to kill an N+1 that lived on the client: to draw the seal on a
 * feed card the page was calling GET /api/stamps/:userId once per distinct
 * owner — the single most expensive endpoint in the system — for one grade
 * letter, and capping the fan-out at 8 meant the 9th curator's cover silently
 * rendered bare. Both numbers fall out of aggregations the feed already runs,
 * so they ride along and the fan-out is gone.
 */
type StampIdentity = { grade: string; rank: 1 | 2 | 3 | null };

function toRec(
  rec: RecRow,
  owner: OwnerRow | undefined,
  identity: StampIdentity,
  tally: RecTally | undefined,
  myVote: number,
  opened: boolean
) {
  return {
    id: rec.id,
    ownerId: rec.ownerId,
    ownerUsername: owner?.username || "",
    ownerAvatar: owner?.avatar || null,
    ownerGrade: identity.grade,
    ownerRank: identity.rank,
    mediaType: rec.mediaType,
    mediaId: rec.mediaId,
    title: rec.title,
    cover: rec.cover,
    blurb: rec.blurb || "",
    up: tally?.up || 0,
    down: tally?.down || 0,
    myVote,
    opened,
    createdAt: rec.createdAt,
    retiredAt: rec.retiredAt,
  };
}

/**
 * The viewer's own vote + open state for a set of recs, in two queries.
 * Returned as maps so the caller can serialise a whole list without looking
 * anything else up per rec.
 */
async function viewerState(viewer: string | null, recIds: string[]) {
  if (!viewer || recIds.length === 0) {
    return { votes: new Map<string, number>(), opens: new Set<string>() };
  }
  const [voteRows, openRows] = await Promise.all([
    prisma.stampVote.findMany({
      where: { userId: viewer, recId: { in: recIds } },
      select: { recId: true, value: true },
    }),
    prisma.stampRecOpen.findMany({
      where: { userId: viewer, recId: { in: recIds } },
      select: { recId: true },
    }),
  ]);
  return {
    votes: new Map(voteRows.map((v) => [v.recId, v.value])),
    opens: new Set(openRows.map((o) => o.recId)),
  };
}

/** A rec read with its owner alongside it — the one shape every list endpoint
 *  fetches, so the owner never needs a second lookup per row. */
type RecWithOwner = RecRow & { owner: OwnerRow };

/**
 * The four scoped reads plus the fold that EVERY list of recommendations needs,
 * in one place.
 *
 * The feed grew this inline; /recent and /for want byte-identical rows, because
 * the frontend draws all three lists with one RecCard and the seal on a card
 * has to mean the same thing wherever it appears. Three copies of "tally the
 * owners, resolve my votes, read the podium, map through toRec" is three
 * chances for ownerGrade or ownerRank to drift apart, and drift here is
 * invisible — a wrong grade still renders.
 *
 * EVERY QUERY IS SCOPED TO THE IDS ON THIS PAGE, never "ALL": the cost is a
 * function of the page size, not of the vote table. tallyVotes answers both
 * halves at once (perRec = this rec's counts, perOwner = its owner's score), so
 * there is no per-rec and no per-owner lookup anywhere in here.
 *
 * `scoreOf` rides along because ordering "best curator first" needs the number
 * behind the grade, not the letter: a band table repeated at the call site
 * would be a second copy of gradeFor's thresholds waiting to disagree with it.
 */
async function serialiseRecs(recs: RecWithOwner[], viewer: string | null) {
  const scoreOf = new Map<string, number>();
  if (recs.length === 0) return { rows: [] as ReturnType<typeof toRec>[], scoreOf };

  const recIds = recs.map((r) => r.id);
  const ownerIds = Array.from(new Set(recs.map((r) => r.ownerId)));

  const [votes, boosts, mine, podium] = await Promise.all([
    tallyVotes(ownerIds),
    tallyBoosts(ownerIds),
    viewerState(viewer, recIds),
    wornPodium(),
  ]);

  const identities = new Map<string, StampIdentity>();
  for (const id of ownerIds) {
    const totals = combine(votes.perOwner.get(id) || 0, boosts.get(id) || 0);
    identities.set(id, { grade: totals.grade, rank: podium.get(id) ?? null });
    scoreOf.set(id, totals.score);
  }

  const rows = recs.map((r) =>
    toRec(
      r,
      r.owner,
      identities.get(r.ownerId) || { grade: gradeFor(0), rank: null },
      votes.perRec.get(r.id),
      mine.votes.get(r.id) || 0,
      mine.opens.has(r.id)
    )
  );
  return { rows, scoreOf };
}

// ── Endpoints ──────────────────────────────────────────────────────────────

/**
 * GET /api/stamps/:userId
 * One member's stamp: grade, the earned/bought split, this week's rank, the
 * seal they carry from last week, and their ACTIVE recommendations.
 *
 * Retired recs are NOT listed — they are past picks, not live recommendations
 * — but their votes are already inside `organic`, so the score on display
 * still answers for them.
 */
export const getStamp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = String(req.params.userId || "");
    const viewer = viewerOf(req);

    const owner = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, avatar: true },
    });
    if (!owner) {
      return res.status(404).json({ success: false, code: "USER_NOT_FOUND", message: "User not found." });
    }

    // rankedBoard is the cached, shared board — a profile view no longer
    // computes two site-wide leaderboards of its own, and the rank it reports
    // is literally the same number /rankings prints.
    const [recs, votes, boosts, board, podium] = await Promise.all([
      prisma.stampRec.findMany({
        where: { ownerId: userId, retiredAt: null },
        orderBy: { createdAt: "desc" },
      }),
      tallyVotes([userId]),
      tallyBoosts([userId]),
      rankedBoard(weekKey()),
      wornPodium(),
    ]);

    const totals = combine(votes.perOwner.get(userId) || 0, boosts.get(userId) || 0);

    // Null, not 0 — "not on the board" and "ranked" are different states and
    // the UI has to be able to tell them apart.
    const weeklyRank = board.find((r) => r.userId === userId)?.rank ?? null;
    const topThreeRank = podium.get(userId) ?? null;

    const mine = await viewerState(viewer, recs.map((r) => r.id));
    const identity: StampIdentity = { grade: totals.grade, rank: topThreeRank };

    res.json({
      success: true,
      data: {
        grade: totals.grade,
        score: totals.score,
        organic: totals.organic,
        boosted: totals.boosted,
        weeklyRank,
        topThreeRank,
        recs: recs.map((r) =>
          toRec(r, owner, identity, votes.perRec.get(r.id), mine.votes.get(r.id) || 0, mine.opens.has(r.id))
        ),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/stamps/rankings?week=2026-W31
 * The weekly board. Defaults to the current week.
 *
 * EVERY NUMBER ON A ROW NAMES ITS OWN TIMEFRAME. The row used to carry
 * `weekScore` beside a bare `organic`/`boosted` pair that was all-time, and the
 * client — reasonably — drew them as that week's breakdown, so a member could
 * read "0 earned · 0 boosted" next to "5 this week". Now the week's split is
 * `weekOrganic`/`weekBoosted` (these two always add up to weekScore) and the
 * lifetime figures are `lifetimeOrganic`/`lifetimeBoosted`/`lifetimeScore`.
 * `grade` stays lifetime — a badge that reset every Monday wouldn't be a
 * reputation — and `topThreeRank` is the seal the member is wearing right now.
 */
export const getRankings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requested = String(req.query.week || "").trim();
    if (requested && !/^\d{4}-W\d{2}$/.test(requested)) {
      return res.status(400).json({ success: false, code: "BAD_WEEK", message: "Bad week key." });
    }
    const week = requested || weekKey();

    // Ranked (and already stripped of deleted accounts) BEFORE the slice, so a
    // full page is BOARD_LIMIT rows and the ranks are contiguous. Filtering
    // after the slice is what would hand back 97 rows out of a page of 100.
    const page = (await rankedBoard(week)).slice(0, BOARD_LIMIT);
    const ids = page.map((r) => r.userId);

    const [users, votes, boosts, podium] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, username: true, avatar: true },
      }),
      tallyVotes(ids),
      tallyBoosts(ids),
      wornPodium(),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));

    const entries = page.map((row) => {
      // The existence filter already ran inside rankedBoard; this fallback only
      // covers an account deleted inside the cache window. Dropping the row
      // here instead would put a hole in the ranks the reader can see.
      const user = byId.get(row.userId);
      const life = combine(votes.perOwner.get(row.userId) || 0, boosts.get(row.userId) || 0);
      return {
        userId: row.userId,
        username: user?.username || "",
        avatar: user?.avatar || null,
        grade: life.grade,
        rank: row.rank,
        weekScore: row.weekScore,
        weekOrganic: row.weekOrganic,
        weekBoosted: row.weekBoosted,
        lifetimeScore: life.score,
        lifetimeOrganic: life.organic,
        lifetimeBoosted: life.boosted,
        topThreeRank: podium.get(row.userId) ?? null,
      };
    });

    res.json({ success: true, data: { week, entries } });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/stamps/endorsements
 * The at-most-nine covers that wear a curator's seal site-wide.
 *
 * PUBLIC AND UNAUTHENTICATED ON PURPOSE. It is decoration on a browse grid, it
 * says nothing about the reader, and it is identical for everybody — so a
 * signed-out visitor sees the podium's picks too, which is the point of a prize
 * whose value is reach. No viewer is read, so nothing here can vary per user
 * and the whole response stays one shared cached document.
 *
 * The client is expected to fetch this ONCE per session and look rows up by
 * (mediaType, mediaId). There must never be a per-card request behind a seal.
 */
export const getEndorsements = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { week, rows } = endorsements();
    res.json({ success: true, data: { podiumWeek: week, endorsements: await rows } });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/stamps/feed?userId=<viewer>
 * Active recommendations from everyone the viewer follows, newest first.
 *
 * Constant queries: follows, recs (owners come back on the same read), then
 * serialiseRecs' four scoped reads. Nothing is looked up per rec and nothing is
 * looked up per owner.
 */
export const getFeed = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewer = viewerOf(req, "userId");
    if (!viewer) {
      return res.status(400).json({ success: false, code: "MISSING_VIEWER", message: "Missing userId." });
    }

    const follows = await prisma.follow.findMany({
      where: { followerId: viewer },
      select: { followingId: true },
    });
    if (follows.length === 0) return res.json({ success: true, data: [] });

    const recs = await prisma.stampRec.findMany({
      where: { ownerId: { in: follows.map((f) => f.followingId) }, retiredAt: null },
      orderBy: { createdAt: "desc" },
      take: FEED_LIMIT,
      include: { owner: { select: { id: true, username: true, avatar: true } } },
    });
    if (recs.length === 0) return res.json({ success: true, data: [] });

    // The response stays a BARE ARRAY — this endpoint's shipped contract — even
    // though the two newer lists wrap their rows in an object. The rows
    // themselves come from the shared serialiser, so all three carry the same
    // Rec.
    const { rows } = await serialiseRecs(recs, viewer);
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/stamps/recent?type=<all|anime|manhwa|novel>&cursor=<recId>&viewer=<id>
 * EVERY member's active recommendations, newest first — the missing half of the
 * feed.
 *
 * Until this existed a recommendation could only be found by visiting one
 * profile at a time or through /feed, which shows you only the people you
 * ALREADY follow — so the system's whole discovery loop was closed to anyone
 * who hadn't already found the curators. This is the open door; /for is the
 * other direction.
 *
 * WHY A KEYSET AND NOT AN OFFSET. New stamps land at the TOP of this ordering
 * while somebody is scrolling it. With `skip: n` every insert shifts the whole
 * tail down one, so page two re-serves the last row of page one — the reader
 * sees a duplicate, and a retire in the same window silently eats a row
 * instead. The anchor here is a position IN the sort, so inserts above it and
 * removals below it cannot move it.
 *
 * The anchor is resolved by id WITHOUT the retiredAt filter on purpose: if the
 * rec someone is paging from is retired mid-scroll, it must still locate the
 * position it used to hold. Treating a vanished anchor as "start over" would
 * restart an infinite scroll at the top, which reads as duplicated content.
 */
export const getRecentRecs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewer = viewerOf(req);

    // Omitted and "all" mean the same thing. An unrecognised mode is a 400
    // rather than a silent fall-through to "all": answering a filtered request
    // with the unfiltered set looks like it worked and is wrong.
    const type = String(req.query.type || "all").trim() || "all";
    if (type !== "all" && !MEDIA_TYPES.has(type)) {
      return res.status(400).json({ success: false, code: "UNKNOWN_MODE", message: "Unknown mode." });
    }

    const cursorId = String(req.query.cursor || "").trim();
    let after: { id: string; createdAt: Date } | null = null;
    if (cursorId) {
      const anchor = await prisma.stampRec.findUnique({
        where: { id: cursorId },
        select: { id: true, createdAt: true },
      });
      /**
       * Retiring KEEPS the row, so a cursor normally stays resolvable even
       * when the rec it points at leaves the active three — which is exactly
       * why the anchor is looked up without the retiredAt filter. But a
       * curator deleting their ACCOUNT cascades their recs away, so a cursor
       * can still be stranded mid-scroll. Hence BAD_CURSOR rather than an
       * assumption the id was forged: the client drops it and re-reads page
       * one, which is recoverable, instead of being told the read failed.
       */
      if (!anchor) {
        return res
          .status(400)
          .json({ success: false, code: "BAD_CURSOR", message: "Unknown cursor." });
      }
      after = anchor;
    }

    // (createdAt, id) is the sort AND the key. createdAt alone is not unique —
    // two stamps inside the same millisecond would order arbitrarily between
    // two reads, which is exactly how a keyset drops or repeats a row — so the
    // id breaks the tie in both the ORDER BY and the comparison below.
    const rows = await prisma.stampRec.findMany({
      where: {
        retiredAt: null,
        ...(type === "all" ? {} : { mediaType: type }),
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      // One extra row is the "is there more" probe, so the answer costs no
      // count() over the table.
      take: RECENT_PAGE + 1,
      include: { owner: { select: { id: true, username: true, avatar: true } } },
    });

    const page = rows.slice(0, RECENT_PAGE);
    // null on the last page — the client stops when the cursor stops coming
    // back, so a short page is never mistaken for the end and vice versa.
    const nextCursor = rows.length > RECENT_PAGE ? page[page.length - 1].id : null;

    const { rows: recs } = await serialiseRecs(page, viewer);
    res.json({ success: true, data: { recs, nextCursor } });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/stamps/for/:mediaType/:mediaId?viewer=<id>
 * WHO STAMPED THIS. Every active recommendation of one title, best curator
 * first.
 *
 * The seal on a cover already answers this for the three podium curators; this
 * answers it for everyone else, on the title's own page, without anybody having
 * to guess whose profile to open.
 *
 * ORDER: podium seals (rank 1..3) ahead of everyone, then the stronger stamp,
 * then the newer recommendation. The middle key is the owner's SCORE, not their
 * grade letter — gradeFor is monotonic in score, so score-descending can never
 * put a lower grade first, and it additionally settles two curators inside the
 * same band instead of leaving them to an arbitrary tie.
 *
 * :mediaId is NOT decoded here. Express has already run decodeURIComponent on
 * every route param by the time a handler sees it, so the "nf:slug" the client
 * sent as "nf%3Aslug" arrives whole; decoding a second time would corrupt any
 * id whose own text contains a percent sequence.
 */
export const getStampersFor = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewer = viewerOf(req);

    // The same MEDIA_TYPES wall createRec uses, so a mode that cannot be
    // stamped cannot be asked about either.
    const mediaType = String(req.params.mediaType || "");
    if (!MEDIA_TYPES.has(mediaType)) {
      return res.status(400).json({ success: false, code: "UNKNOWN_MODE", message: "Unknown mode." });
    }
    const mediaId = String(req.params.mediaId || "").trim();
    if (!mediaId || mediaId.length > MAX_ID) {
      return res.status(400).json({ success: false, code: "BAD_MEDIA", message: "Bad media id." });
    }

    // Retired recs are excluded by the rule every other list follows: a pick
    // that was pulled down has stopped recommending. Newest first, so if the
    // cap ever bites it takes the oldest.
    let found: RecWithOwner[] = await prisma.stampRec.findMany({
      where: { mediaType, mediaId, retiredAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: STAMPERS_LIMIT,
      include: { owner: { select: { id: true, username: true, avatar: true } } },
    });

    if (found.length >= STAMPERS_LIMIT) {
      // The cap actually bit. A newest-first cut can drop a podium curator who
      // stamped this title weeks ago, and "best curator first" is the one
      // ordering promise this endpoint makes — a seal missing from the list
      // that the cover itself is wearing would be the visible bug. Paid ONLY on
      // this path: at most three owner ids, and it rides the existing
      // (ownerId, mediaType, mediaId) index.
      const podiumIds = Array.from((await wornPodium()).keys());
      if (podiumIds.length > 0) {
        const sealed = await prisma.stampRec.findMany({
          where: { ownerId: { in: podiumIds }, mediaType, mediaId, retiredAt: null },
          include: { owner: { select: { id: true, username: true, avatar: true } } },
        });
        // Merged by rec id, so a curator already inside the cap isn't doubled.
        const byId = new Map(found.map((r) => [r.id, r]));
        for (const rec of sealed) byId.set(rec.id, rec);
        found = Array.from(byId.values());
      }
    }

    const { rows, scoreOf } = await serialiseRecs(found, viewer);

    // Unranked sorts as 4 so the podium's three sit ahead of it without a
    // separate null branch in every comparison.
    rows.sort(
      (a, b) =>
        (a.ownerRank ?? 4) - (b.ownerRank ?? 4) ||
        (scoreOf.get(b.ownerId) || 0) - (scoreOf.get(a.ownerId) || 0) ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        a.id.localeCompare(b.id)
    );

    // Empty array, not 404: "nobody has stamped this yet" is a normal answer
    // about a real title and the client draws a prompt to be the first.
    res.json({ success: true, data: { stampers: rows } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/stamps/recs  { mediaType, mediaId, title, cover, blurb }
 * Puts your name on something.
 *
 * Three different 409s live here and the client has to tell them apart —
 * "retire one to make room" is exactly the wrong advice for a member with a
 * free slot who re-stamped a title — so each carries a `code`:
 * SLOTS_FULL / ALREADY_STAMPED / PREVIOUSLY_STAMPED / SLOT_TAKEN.
 *
 * The free slot is picked here, but the CAP is the database's:
 * @@unique([ownerId, slot]) with slot NULL once retired. Two creates fired at
 * the same instant both compute the same free slot, and the second one loses
 * on the constraint (P2002) instead of quietly producing a fourth active rec.
 */
export const createRec = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body || {}) as {
      userId?: string;
      mediaType?: string;
      mediaId?: string;
      title?: string;
      cover?: string;
      blurb?: string;
    };
    const userId = actorFor(req, res, body.userId);
    if (!userId) return;

    const mediaType = String(body.mediaType || "");
    if (!MEDIA_TYPES.has(mediaType)) {
      return res.status(400).json({ success: false, code: "UNKNOWN_MODE", message: "Unknown mode." });
    }
    const mediaId = String(body.mediaId || "").trim();
    const title = String(body.title || "").trim();
    if (!mediaId || mediaId.length > MAX_ID || !title) {
      return res
        .status(400)
        .json({ success: false, code: "BAD_MEDIA", message: "Pick something to recommend." });
    }
    const cover =
      typeof body.cover === "string" && body.cover.trim() ? body.cover.trim().slice(0, MAX_COVER) : null;
    const blurb =
      typeof body.blurb === "string" && body.blurb.trim() ? body.blurb.trim().slice(0, MAX_BLURB) : null;

    const owner = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, avatar: true },
    });
    if (!owner) {
      return res.status(404).json({ success: false, code: "USER_NOT_FOUND", message: "User not found." });
    }

    const [active, prior, totals, podium] = await Promise.all([
      prisma.stampRec.findMany({
        where: { ownerId: userId, retiredAt: null },
        select: { id: true, slot: true },
      }),
      // ACROSS ALL TIME, not just the live slots. Retire-and-re-stamp would
      // otherwise mint a fresh rec id for the same title — and a fresh rec id
      // is a fresh vote slate, since StampVote is unique per (rec, user) — so
      // the same three friends could re-approve the same book every hour.
      prisma.stampRec.findFirst({
        where: { ownerId: userId, mediaType, mediaId },
        select: { id: true, retiredAt: true },
      }),
      stampTotals(userId),
      wornPodium(),
    ]);

    // Duplicates are checked BEFORE the slot count: when both are true, being
    // told to retire something is advice that cannot help.
    if (prior && !prior.retiredAt) {
      return res.status(409).json({
        success: false,
        code: "ALREADY_STAMPED",
        message: "That's already on your stamp.",
      });
    }
    if (prior) {
      return res.status(409).json({
        success: false,
        code: "PREVIOUSLY_STAMPED",
        message: "You've stamped that before. A title can only be stamped once — the verdict on it stands.",
      });
    }
    if (active.length >= MAX_ACTIVE) {
      return res.status(409).json({
        success: false,
        code: "SLOTS_FULL",
        message: `A stamp carries ${MAX_ACTIVE} recommendations. Retire one first.`,
      });
    }

    const used = new Set(active.map((r) => r.slot));
    const slot = [0, 1, 2].find((s) => !used.has(s));
    if (slot === undefined) {
      return res
        .status(409)
        .json({ success: false, code: "SLOTS_FULL", message: "No free recommendation slot." });
    }

    let rec;
    try {
      rec = await prisma.stampRec.create({
        data: { ownerId: userId, mediaType, mediaId, title: title.slice(0, MAX_TITLE), cover, blurb, slot },
      });
    } catch (e: any) {
      // The slot constraint fired — one of this member's own requests took it in
      // between. Distinct from SLOTS_FULL: retrying works, retiring is pointless.
      if (e?.code === "P2002") {
        return res
          .status(409)
          .json({ success: false, code: "SLOT_TAKEN", message: "That slot was just filled — try again." });
      }
      throw e;
    }

    // The endorsement payload lists only the podium's active recs, so only a
    // podium member's create can make it wrong — and for that member the seal
    // landing on their new pick IS the prize they earned, which should not wait
    // out a five-minute TTL. The podium was already read above; the check is
    // free.
    if (podium.has(userId)) invalidateEndorsements();

    res.status(201).json({
      success: true,
      data: toRec(rec, owner, { grade: totals.grade, rank: podium.get(userId) ?? null }, undefined, 0, false),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/stamps/recs/:recId
 * Retires a recommendation: frees the slot, keeps the row.
 *
 * NEVER a hard delete. The votes on this rec go on counting toward the owner's
 * organic score forever — deleting would let a member wipe a bad call and walk
 * away with the grade they had before it.
 */
export const retireRec = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const recId = String(req.params.recId || "");
    const userId = actorFor(req, res, (req.body || {}).userId);
    if (!userId) return;

    const rec = await prisma.stampRec.findUnique({ where: { id: recId } });
    if (!rec) {
      return res
        .status(404)
        .json({ success: false, code: "REC_NOT_FOUND", message: "Recommendation not found." });
    }
    if (rec.ownerId !== userId) {
      return res
        .status(403)
        .json({ success: false, code: "NOT_OWNER", message: "That isn't your recommendation." });
    }

    // Guarded so a double-tap can't rewrite retiredAt to a later moment (which
    // would move the rec in any history ordered by it). Already-retired is a
    // success: the caller wanted it gone and it is gone.
    await prisma.stampRec.updateMany({
      where: { id: recId, retiredAt: null },
      data: { retiredAt: new Date(), slot: null },
    });

    // A pulled-down pick must stop wearing its seal site-wide at once — the
    // same rule that closes a retired rec to new opens and votes, and the
    // louder half of it, since a seal on a browse grid keeps recruiting readers
    // for a recommendation its own curator has withdrawn. Membership is a
    // cached board read; if it cannot be answered, invalidate anyway rather
    // than let a lookup failure keep a withdrawn cover decorated.
    try {
      if ((await wornPodium()).has(userId)) invalidateEndorsements();
    } catch {
      invalidateEndorsements();
    }

    res.json({ success: true, data: { id: recId, retired: true } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/stamps/recs/:recId/open
 * Records that this person opened the recommendation. Idempotent.
 *
 * THIS IS THE VOTE GATE. Without a row here the vote endpoint refuses to write
 * a verdict, so a brigade organised elsewhere can't dump votes on something
 * none of them ever clicked through to. One row per person per rec, so
 * re-opening is not a second signal.
 */
export const openRec = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const recId = String(req.params.recId || "");
    const userId = actorFor(req, res, (req.body || {}).userId);
    if (!userId) return;

    const rec = await prisma.stampRec.findUnique({
      where: { id: recId },
      select: { id: true, retiredAt: true },
    });
    if (!rec) {
      return res
        .status(404)
        .json({ success: false, code: "REC_NOT_FOUND", message: "Recommendation not found." });
    }
    // A retired rec is listed by no endpoint, so nobody can find it to
    // counter-vote it. Letting opens (and therefore votes) keep landing on one
    // made it a private score channel between the owner and whoever they handed
    // the id to. The verdicts already cast on it still count; new ones don't.
    if (rec.retiredAt) {
      return res.status(409).json({
        success: false,
        code: "REC_RETIRED",
        message: "That recommendation has been retired.",
      });
    }

    // upsert with an empty update: concurrent opens collapse onto one row
    // rather than racing the unique constraint into a 500.
    await prisma.stampRecOpen.upsert({
      where: { recId_userId: { recId, userId } },
      update: {},
      create: { recId, userId },
    });

    res.json({ success: true, data: { recId, opened: true } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/stamps/recs/:recId/vote  { value: 1 | -1 }
 * The explicit verdict. 403 if this person never opened the rec.
 *
 * One vote per person per rec — changing your mind UPDATES the row, so the
 * tallies always equal the number of distinct people who voted.
 */
export const voteRec = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const recId = String(req.params.recId || "");
    const body = (req.body || {}) as { userId?: string; value?: number };
    const userId = actorFor(req, res, body.userId);
    if (!userId) return;

    const value = Number(body.value);
    if (value !== 1 && value !== -1) {
      return res.status(400).json({ success: false, code: "BAD_VALUE", message: "Vote must be 1 or -1." });
    }

    const rec = await prisma.stampRec.findUnique({
      where: { id: recId },
      select: { id: true, ownerId: true, retiredAt: true },
    });
    if (!rec) {
      return res
        .status(404)
        .json({ success: false, code: "REC_NOT_FOUND", message: "Recommendation not found." });
    }
    if (rec.retiredAt) {
      // Same reason as openRec: retired means closed to NEW traffic, not erased.
      return res.status(409).json({
        success: false,
        code: "REC_RETIRED",
        message: "That recommendation has been retired.",
      });
    }
    // Grading your own homework. The boost endpoint blocks self-boosting for
    // the same reason; a stamp has to be scored by other people or it means
    // nothing. Its own code, because the client must not read this as the gate.
    if (rec.ownerId === userId) {
      return res
        .status(403)
        .json({ success: false, code: "SELF_VOTE", message: "You can't vote on your own recommendation." });
    }

    // THE GATE. Checked against the DB, not a client claim.
    const [opened, existing] = await Promise.all([
      prisma.stampRecOpen.findUnique({
        where: { recId_userId: { recId, userId } },
        select: { id: true },
      }),
      prisma.stampVote.findUnique({
        where: { recId_userId: { recId, userId } },
        select: { value: true, week: true },
      }),
    ]);
    if (!opened) {
      return res.status(403).json({
        success: false,
        code: "NOT_OPENED",
        message: "Open the recommendation before voting on it.",
      });
    }

    const week = weekKey();
    if (!existing) {
      // upsert, not create: two first votes racing collapse onto one row.
      await prisma.stampVote.upsert({
        where: { recId_userId: { recId, userId } },
        update: { value, week },
        create: { recId, userId, ownerId: rec.ownerId, value, week },
      });
    } else if (existing.value !== value) {
      // `week` moves ONLY when the verdict actually changes, so the weekly
      // board credits the week the person changed their mind in. Re-stamping it
      // on an unchanged re-vote let the same physical row be re-credited into
      // every new ISO week forever: three friends flipping down-then-up would
      // have re-earned last month's score every Monday, with no new content.
      await prisma.stampVote.update({
        where: { recId_userId: { recId, userId } },
        data: { value, week },
      });
    }
    // else: identical re-vote — deliberately not a write at all.

    if (!existing || existing.value !== value) {
      invalidateBoard(week);
      // A flipped verdict LEAVES the week it used to sit in, so that board is
      // stale too. (Same key when the flip happens in the same week — the
      // delete is idempotent.)
      if (existing) invalidateBoard(existing.week);
    }

    // Send back the rec's fresh counts AND the owner's recomputed stamp — a
    // vote visibly moving someone's grade is the entire feature, and the client
    // shouldn't have to refetch the profile to see it.
    const [groups, totals] = await Promise.all([
      prisma.stampVote.groupBy({
        by: ["value"],
        where: { recId },
        _count: { _all: true },
      }),
      stampTotals(rec.ownerId),
    ]);
    const up = groups.find((g) => g.value > 0)?._count._all || 0;
    const down = groups.find((g) => g.value < 0)?._count._all || 0;

    res.json({
      success: true,
      data: {
        recId,
        up,
        down,
        myVote: value,
        owner: { userId: rec.ownerId, ...totals },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/stamps/:userId/boost  { amount }
 * Spend Arise Points to lift someone's stamp.
 *
 * The booster is the token holder — never a body field. A body-trusted
 * boosterId meant an unauthenticated request could spend a VICTIM's balance
 * into the ATTACKER's own grade, since "you can't boost your own stamp" was
 * only ever a comparison between two strings the caller supplied.
 *
 * The spend is the auction's atomic conditional decrement: the balance check
 * and the deduction are ONE database operation, so somebody firing boosts at
 * two stamps at the same instant cannot pass the check twice against the same
 * balance and overdraw. count === 0 means insufficient — and the whole
 * transaction rolls back, so a StampBoost row can never exist unpaid.
 *
 * What the AP actually buys is deliberately limited: floor(sqrt(total)) per
 * booster, capped at the recipient's earned score. It moves the grade — that
 * was the owner's call — but it cannot manufacture one.
 */
export const boostStamp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetId = String(req.params.userId || "");
    const body = (req.body || {}) as { boosterId?: string; amount?: number };

    const boosterId = actorFor(req, res, body.boosterId);
    if (!boosterId) return;

    if (body.amount == null) {
      return res.status(400).json({ success: false, code: "BAD_AMOUNT", message: "Missing amount." });
    }
    if (boosterId === targetId) {
      return res
        .status(400)
        .json({ success: false, code: "SELF_BOOST", message: "You can't boost your own stamp." });
    }

    const amount = Math.floor(Number(body.amount));
    if (!(amount > 0)) {
      return res
        .status(400)
        .json({ success: false, code: "BAD_AMOUNT", message: "Boost must be a positive number." });
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, username: true },
    });
    if (!target) {
      return res.status(404).json({ success: false, code: "USER_NOT_FOUND", message: "User not found." });
    }

    const week = weekKey();

    try {
      await prisma.$transaction(async (tx) => {
        const booster = await tx.user.findUnique({
          where: { id: boosterId },
          select: { id: true, username: true, arisePoints: true },
        });
        if (!booster) throw new BoostError(404, "USER_NOT_FOUND", "User not found.");

        const debit = await tx.user.updateMany({
          where: { id: boosterId, arisePoints: { gte: amount } },
          data: { arisePoints: { decrement: amount } },
        });
        if (debit.count === 0) {
          // 400, not 402 — the API contract for this endpoint says 400 for an
          // insufficient balance and the client is written against it.
          throw new BoostError(
            400,
            "INSUFFICIENT_POINTS",
            `You need ${amount.toLocaleString()} Arise Points — you have ${booster.arisePoints.toLocaleString()}.`
          );
        }

        await tx.pointLog.create({
          data: { userId: boosterId, amount: -amount, reason: `stamp-boost:${targetId}` },
        });
        await tx.stampBoost.create({ data: { stampUserId: targetId, boosterId, amount, week } });
        await tx.notification.create({
          data: {
            userId: targetId,
            actorId: boosterId,
            type: "stamp",
            message: `${booster.username} boosted your stamp with ${amount.toLocaleString()} Arise Points.`,
            link: `/user/${target.username}`,
          },
        });
      });
    } catch (e) {
      if (e instanceof BoostError) {
        return res.status(e.status).json({ success: false, code: e.code, message: e.message });
      }
      throw e;
    }

    invalidateBoard(week);

    const [totals, me] = await Promise.all([
      stampTotals(targetId),
      prisma.user.findUnique({ where: { id: boosterId }, select: { arisePoints: true } }),
    ]);

    res.json({
      success: true,
      data: {
        userId: targetId,
        grade: totals.grade,
        score: totals.score,
        organic: totals.organic,
        boosted: totals.boosted,
        arisePoints: me?.arisePoints ?? 0,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Typed carrier so a validation failure inside the boost transaction rolls it
// back AND surfaces the right status, instead of a generic 500 with the points
// already gone. (auction.controller's BidError, same job.) It carries the
// machine-readable code too, so the client can tell "you're broke" from
// "that account is gone" without matching on prose.
class BoostError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
