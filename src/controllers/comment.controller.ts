import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { processMentions } from "../utils/mentions";
import { payout } from "../utils/economy";
import { resolveActor, requireStaff } from "../lib/staff";

/**
 * ONE author select, used by every path that returns a comment.
 *
 * This existed as FIVE hand-copied literals — the two read paths, the replies
 * loop, the create echo and the edit echo — and they had already drifted apart
 * in ways users could see. `editComment` selected six fields under a comment
 * asserting it matched the read paths, so fixing a typo in your own comment
 * blanked your badges, frame and effect until a refresh; `createComment`
 * dropped role and purchasedTags, so a just-posted comment showed a different
 * badge set than the same comment one reload later.
 *
 * Forum posts ARE comments here (a Comment row with a `tag`), so this one
 * constant governs the forum and every media comment surface at once. Adding a
 * field here reaches all of them; that is the entire point of hoisting it.
 */
const COMMENT_AUTHOR_SELECT = {
  id: true, username: true, avatar: true, arisePoints: true, xp: true,
  // role and purchasedTags drive the STAFF / LEAD DEV / DONOR badges from
  // real account data rather than a hardcoded username list.
  role: true, purchasedTags: true,
  activeRole: true, activeTag: true, activeEffect: true, activeTheme: true,
  activeColor: true, activeFont: true, activeFrame: true,
  // WORN TITLES. Wearer-ordered, index 0 is the one they lead with. Until now
  // no comment endpoint selected these at all, so titles existed on the
  // profile and could not be shown anywhere else in the product. `cardTitle`
  // rides along as the legacy fallback for accounts that earned a title before
  // equippedTitles existed — the profile rack already falls back to it, and a
  // surface that didn't would show them a title on one screen and not another.
  equippedTitles: true,
  cardTitle: true,
};

/**
 * ONE shape for a comment on the wire, so every path that returns one —
 * the feed, the pinned shelf, a single post — agrees on the fields the
 * client reads. Raw vote and poll-vote rows are collapsed into tallies
 * and dropped; sending them all would leak who voted for what.
 */
function shapeComment(comment: any, userId?: string) {
  const score = comment.votes.reduce((acc: number, vote: any) => acc + vote.value, 0);
  const userVote = userId ? comment.votes.find((v: any) => v.userId === userId)?.value || 0 : 0;
  // Separate tallies as well as the net score: the UI shows a like count
  // AND a dislike count, and a single net number renders as a negative
  // beside a heart the moment dislikes outweigh likes.
  const upvotes = comment.votes.filter((v: any) => v.value === 1).length;
  const downvotes = comment.votes.filter((v: any) => v.value === -1).length;

  let poll: any;
  if (comment.poll) {
    const all = comment.poll.votes || [];
    const mine = userId ? all.find((v: any) => v.userId === userId) : undefined;
    poll = {
      id: comment.poll.id,
      question: comment.poll.question,
      closesAt: comment.poll.closesAt,
      closed: !!comment.poll.closesAt && new Date(comment.poll.closesAt).getTime() <= Date.now(),
      totalVotes: all.length,
      myOptionId: mine ? mine.optionId : null,
      options: (comment.poll.options || []).map((o: any) => ({
        id: o.id,
        text: o.text,
        votes: all.filter((v: any) => v.optionId === o.id).length,
      })),
    };
  }

  return {
    ...comment,
    score,
    upvotes,
    downvotes,
    userVote,
    poll,
    votes: undefined, // hide raw votes array to save bandwidth
  };
}

export const getComments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const animeId = req.query.animeId as string | undefined;
    const mangaId = req.query.mangaId as string | undefined;
    const chapterId = req.query.chapterId as string | undefined;
    const novelId = req.query.novelId as string | undefined;
    // Guild board — same shape as the mangaId/novelId filters: the board is
    // the existing forum machinery scoped to one guild's comments.
    const guildId = req.query.guildId as string | undefined;

    /**
     * TWO DIFFERENT USERS, TWO DIFFERENT PARAMS.
     *
     * `userId` is the VIEWER — it only personalises the response (marks which
     * votes and poll choices are yours) and must never filter. Every feed
     * sends it for whoever is signed in, so making it a filter would collapse
     * the whole site's comments to "only mine".
     *
     * `authorId` is WHOSE comments to return. The profile page's recent-
     * comments rail asked this of `userId` for months and the parameter was
     * silently ignored — every profile showed the newest comments from the
     * entire site, everyone's, under "what this person has been saying".
     */
    const userId = req.query.userId as string | undefined;
    const authorId = req.query.authorId as string | undefined;
    const sort = req.query.sort as string | undefined;
    const search = req.query.search as string | undefined;
    const mediaOnly = req.query.mediaOnly === 'true';
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const skip = (page - 1) * limit;

    const where: any = {};
    if (animeId) {
      where.animeId = parseInt(animeId);
      /**
       * Per-episode threads. episodeNo has been STAMPED on new comments for a
       * while but never filtered, so every episode's watch page showed the
       * whole series' chatter. The filter is opt-in by param — the series
       * Discussions tab keeps sending no episodeNo and stays series-wide, so
       * nothing vanishes from the hub.
       */
      const episodeNoRaw = req.query.episodeNo as string | undefined;
      if (episodeNoRaw) {
        const ep = parseInt(episodeNoRaw);
        if (Number.isFinite(ep) && ep > 0) where.episodeNo = ep;
      }
    }
    if (mangaId) where.mangaId = mangaId;
    if (chapterId) where.chapterId = chapterId;
    if (novelId) where.novelId = novelId;
    // Guild boards are members-only rooms, not another feed. Without the
    // else, every guild post also matched the default forum/media lists and
    // the whole board leaked to everyone by omission.
    if (guildId) where.guildId = guildId;
    else where.guildId = null;
    // Series-level views must EXCLUDE chapter chatter. This used to apply to
    // manhwa only — novels had no chapter comments to exclude. The novel
    // reader now has its own per-chapter threads, so without widening this,
    // every chapter's comments spilled into the series Discussions tab.
    if (!animeId && (mangaId || novelId) && !chapterId) {
      where.chapterId = null;
    }
    
    if (search) where.content = { contains: search, mode: 'insensitive' };
    if (mediaOnly) where.mediaUrl = { not: null };
    if (authorId) where.userId = authorId;

    // ── FORUM ──────────────────────────────────────────────────────────────
    // `forum=true` means standalone posts: the ones not attached to any anime,
    // manhwa or novel. Without this the community feed would also pull every
    // episode and chapter comment on the site, which is a different thing
    // entirely and would bury the forum in reading chatter.
    const forum = req.query.forum === 'true';
    const tag = req.query.tag as string | undefined;
    if (forum) {
      where.animeId = null;
      where.mangaId = null;
      where.chapterId = null;
      where.novelId = null;
      // Guild boards are their own rooms — without this every guild's
      // internal chatter would spill into the public community feed.
      where.guildId = null;
    }
    if (tag && tag !== 'All') where.tag = tag;

    // ── GLOBAL COMMENT FEED ────────────────────────────────────────────────
    // The mirror of `forum`: only comments that ARE attached to something you
    // can read or watch. Without this the global feed would also list forum
    // posts, which now live in their own place — the two views would show each
    // other's content and neither would mean anything.
    const globalFeed = req.query.global === 'true';
    const source = req.query.source as string | undefined; // anime | manhwa | novel
    if (globalFeed) {
      if (source === 'anime') where.animeId = { not: null };
      else if (source === 'manhwa') where.mangaId = { not: null };
      else if (source === 'novel') where.novelId = { not: null };
      else {
        where.OR = [
          { animeId: { not: null } },
          { mangaId: { not: null } },
          { novelId: { not: null } },
        ];
      }
    }

    // To keep threads intact, paginate only root comments unless searching/
    // filtering. An authorId query is exempt too: replies ARE that person's
    // comments, and a user whose activity is mostly replies would otherwise
    // show an empty profile rail.
    if (!search && !mediaOnly && !authorId) {
       where.parentId = null;
    }

    // Declared BEFORE any branch that reads it — a `const` used earlier in
    // the same block is a tsc error, and on this backend one type error
    // takes the entire API deploy down.
    const COMMENT_INCLUDE = {
      user: { select: COMMENT_AUTHOR_SELECT },
      votes: true,
      poll: { include: { options: { orderBy: { order: "asc" as const } }, votes: true } },
    };

    /**
     * `pinned=true` returns ONLY pinned posts, unpaginated and newest-pinned
     * first. The forum's pinned shelf uses this instead of filtering whatever
     * happened to land in page one: a pin that fell outside the first 30 rows,
     * or that the active tag filtered out, silently vanished from the shelf.
     */
    if (String(req.query.pinned || "") === "true") {
      where.isPinned = true;
      const pinnedRows: any[] = await prisma.comment.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 8,
        include: COMMENT_INCLUDE,
      });
      return res.json({ success: true, data: pinnedRows.map((c: any) => shapeComment(c, userId)) });
    }

    /**
     * `top` cannot be expressed as a Prisma orderBy: score is the SUM of
     * CommentVote.value (each +1/-1), not a count, so `votes: { _count: 'desc' }`
     * would rank a post with 5 downvotes above one with 4 upvotes.
     *
     * It used to fall through to the `createdAt desc` branch below, which made
     * `sort=top` return byte-identical results to `sort=newest` — and because
     * only the first `limit` rows were fetched, the genuinely highest-scoring
     * comments (which are usually the OLDER ones that have had time to collect
     * votes) were never even loaded, so no amount of client-side re-sorting
     * could surface them.
     *
     * So for `top` we pull the candidate set, score it in JS, then paginate.
     * TOP_SCAN_CAP bounds the work; past that we're ranking a sample, not the
     * whole feed, which is an acceptable trade at this scale.
     */
    const TOP_SCAN_CAP = 500;
    // Explicitly typed: both branches produce the same shape (COMMENT_INCLUDE),
    // and an un-annotated `let` here would rely on evolving-any inference.
    let comments: any[];

    if (sort === 'top') {
      // Annotated any[]: COMMENT_INCLUDE is a variable, so TS widens its
      // `votes: true` to `boolean`, and Prisma's payload conditionals then
      // resolve to a union that doesn't expose `.votes`. Inline literals narrow
      // fine; a shared constant does not. Explicit here rather than risking a
      // tsc failure, which on this backend takes the whole API down.
      const scanned: any[] = await prisma.comment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: TOP_SCAN_CAP,
        include: COMMENT_INCLUDE,
      });
      scanned.sort((a: any, b: any) => {
        const sa = a.votes.reduce((acc: number, v: any) => acc + v.value, 0);
        const sb = b.votes.reduce((acc: number, v: any) => acc + v.value, 0);
        if (sb !== sa) return sb - sa;
        // Pinned wins ties, then recency — "top" is the one view where a pinned
        // post leading actually reads as intentional.
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      comments = scanned.slice(skip, skip + limit);
    } else {
      /**
       * `isPinned: 'desc'` used to lead this orderBy for EVERY sort, which meant
       * an explicitly-chosen "New" still opened with a pinned comment that could
       * be weeks older than the actual newest post — the sort looked broken.
       * An explicit chronological choice is now honoured strictly; pinning still
       * ranks in `top` above.
       */
      comments = await prisma.comment.findMany({
        where,
        /**
         * FORUM posts put pinned first on every sort — a pin there means
         * "this stays on top", and the pinned card is also where the Unpin
         * control lives, so a pin that sorted off page one could never be
         * undone. Media comment threads keep strict chronology: a pinned
         * comment weeks older than the newest one leading an explicitly
         * chosen "New" is what made that sort look broken.
         */
        orderBy: forum
          ? [{ isPinned: 'desc' as const }, { createdAt: sort === 'oldest' ? 'asc' as const : 'desc' as const }]
          : { createdAt: sort === 'oldest' ? 'asc' : 'desc' },
        take: limit,
        skip,
        include: COMMENT_INCLUDE,
      });
    }

    let allComments = [...comments];

    /**
     * Fetch replies for whatever we matched, recursively, up to depth 4.
     *
     * This used to be skipped entirely when searching or filtering by media, so
     * the Media view rendered every post with an empty thread beneath it — the
     * conversation simply vanished. The `where` clause decides which comments
     * MATCH; it shouldn't also decide whether those matches get to keep their
     * replies. Descendants are pulled unfiltered on purpose: a media post's
     * text-only replies are still part of that thread.
     */
    if (comments.length > 0) {
       let currentParents = comments.map(c => c.id);
       
       for (let i = 0; i < 4; i++) {
          if (currentParents.length === 0) break;
          const replies = await prisma.comment.findMany({
            where: { parentId: { in: currentParents } },
            include: {
              // Same author select as the roots. This was a hand-copy that had
              // already lost the poll include; sharing the select stops the
              // replies drifting further from the comments above them.
              user: { select: COMMENT_AUTHOR_SELECT },
              votes: true,
            }
          });
          if (replies.length > 0) {
            allComments = allComments.concat(replies);
            currentParents = replies.map(r => r.id);
          } else {
            break;
          }
       }
    }

    // Format the response to include the calculated score and the current user's vote
    // Callback params are annotated because `allComments` is any[] (the two
    // fetch branches for top vs chronological produce the same shape but not the
    // same inferred type). Without these, noImplicitAny rejects the build.
    /**
     * The commenter's own score for this title, so a media comment can show
     * "8/10" beside its author. Ratings are keyed (userId, targetKey) and have
     * no commentId, so this is a join rather than a column — one extra query,
     * scoped to the authors actually on this page, and skipped entirely when
     * the caller sends no targetKey (the forum never does).
     *
     * Honest limitation: this is the author's CURRENT rating, not the one they
     * held when they wrote the comment. An author who never rated shows no pill.
     */
    const ratingKey = req.query.targetKey as string | undefined;
    let authorRatings = new Map<string, number>();
    if (ratingKey) {
      const authorIds = Array.from(
        new Set(allComments.map((c: any) => c.userId).filter(Boolean))
      ) as string[];
      if (authorIds.length > 0) {
        const rows = await prisma.rating.findMany({
          where: { targetKey: ratingKey, userId: { in: authorIds } },
          select: { userId: true, value: true },
        });
        // Tuple assertion is load-bearing: without it the entries infer as
        // (string | number)[][] and strict tsc rejects the Map constructor.
        authorRatings = new Map<string, number>(
          rows.map((r) => [r.userId, r.value] as [string, number])
        );
      }
    }

    const formattedComments = allComments.map((comment: any) => ({
      ...shapeComment(comment, userId),
      authorRating: authorRatings.get(comment.userId) ?? null,
    }));

    res.json({ success: true, data: formattedComments });
  } catch (error) {
    next(error);
  }
};

/** The only topics a post may carry. Anything else is stored as untagged. */
export const FORUM_TAGS = ["General", "Discussion", "Art", "Theory", "News", "Question", "Spoiler", "Meme"];

/**
 * The deep link a notification about a comment should carry.
 *
 * Every notification here used to point at
 * `/community?view=<animeId>&tab=discussions` — which was wrong on three
 * counts. A manhwa or novel comment has no animeId, so its notifications went
 * to bare `/community`, a page that doesn't show that comment at all. A forum
 * post reply did the same. And no link named the comment, so even the anime
 * case dropped you at the top of a feed to scroll on your own.
 *
 * The comment row itself knows which surface it lives on, so the link is built
 * from the row: anime → the community modal flow that already exists; manhwa /
 * novel → the series or chapter page that renders the feed; anything else is
 * forum, where the post IS a root comment, so the thread page is
 * /community/post/<root>. The ?comment= is picked up by CommunityFeed, which
 * scrolls to and highlights that comment.
 *
 * `anchorId` lets a reply notification link to the PARENT thread but anchor on
 * the new reply itself.
 */
const commentDeepLink = (
  c: {
    id: string;
    animeId?: number | null;
    episodeNo?: number | null;
    mangaId?: string | null;
    novelId?: string | null;
    chapterId?: string | null;
    guildId?: string | null;
    parentId?: string | null;
  },
  anchorId?: string
): string => {
  const anchor = `comment=${anchorId || c.id}`;
  // A guild-board comment lives on that guild's page, not in the forum.
  if (c.guildId) return `/guilds/${encodeURIComponent(c.guildId)}?${anchor}`;
  // An episode-stamped comment lives in that episode's thread on the watch
  // page, so that is where its notifications should land — the series modal
  // would show it, but stranded among every other episode's chatter.
  if (c.animeId && c.episodeNo) return `/watch/${c.animeId}?ep=${c.episodeNo}&${anchor}`;
  if (c.animeId) return `/community?view=${c.animeId}&tab=discussions&${anchor}`;
  if (c.mangaId) {
    const base = `/manhwa/${encodeURIComponent(c.mangaId)}`;
    return `${base}${c.chapterId ? `/chapter/${encodeURIComponent(c.chapterId)}` : ""}?${anchor}`;
  }
  if (c.novelId) {
    const base = `/novel/${encodeURIComponent(c.novelId)}`;
    return `${base}${c.chapterId ? `/chapter/${encodeURIComponent(c.chapterId)}` : ""}?${anchor}`;
  }
  // Forum. A reply's parentId IS the thread root (threads are shallow); a root
  // comment is its own thread.
  return `/community/post/${c.parentId || c.id}?${anchor}`;
};

export const createComment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, animeId, animeTitle, episodeNo, mangaId, mangaTitle, chapterId, chapterTitle, novelId, novelTitle, guildId, content, parentId, mediaUrl, title, tag, poll } = req.body;

    /**
     * Guild board posts. The board rides this exact machinery — the only
     * addition is the stamp and a membership gate: a guild's board is for its
     * members, and GuildMember.userId is unique, so one lookup answers both
     * "are they in a guild" and "is it THIS one".
     */
    let guildIdValue = guildId ? String(guildId) : null;
    // Replies inherit the parent's board server-side. Otherwise a reply that
    // simply omits guildId is stored as a PUBLIC comment (and skips the
    // membership gate below) yet still renders inside the guild thread.
    if (parentId) {
      const parentBoard = await prisma.comment.findUnique({
        where: { id: String(parentId) },
        select: { guildId: true },
      });
      if (parentBoard?.guildId) guildIdValue = parentBoard.guildId;
    }
    if (guildIdValue) {
      // A guild post lives on exactly one board. Carrying a media id too
      // would surface a members-only post inside public series tabs.
      if (animeId || mangaId || novelId || chapterId) {
        return res.status(400).json({ success: false, message: "A guild post can't also be attached to a series." });
      }
      // Members-only means the author must be PROVEN, not claimed. The
      // body's userId is client-supplied everywhere in this controller —
      // fine for public chatter, but here it would let anyone post into any
      // guild by naming one of its members. The token decides who's writing.
      const actor = await resolveActor(req);
      if (!actor) {
        return res.status(401).json({ success: false, message: "Sign in again to post on the guild board." });
      }
      if (String(userId || "") !== actor.id) {
        return res.status(403).json({ success: false, message: "You can only post as yourself." });
      }
      const membership = await prisma.guildMember.findUnique({ where: { userId: actor.id } });
      if (!membership || membership.guildId !== guildIdValue) {
        return res.status(403).json({ success: false, message: "Only guild members can post on the guild board." });
      }
    }

    /**
     * An attached poll. Validated here rather than trusted: at least two
     * non-empty options (a one-option poll is a statement), capped at 6 so
     * the card stays readable, and a duration in hours that can't be
     * negative. `closesInHours` of 0 / missing means it never closes.
     */
    let pollData: { question: string; closesAt: Date | null; options: string[] } | null = null;
    if (poll && typeof poll.question === "string" && poll.question.trim()) {
      const options = Array.isArray(poll.options)
        ? poll.options.map((o: any) => String(o || "").trim()).filter((o: string) => o.length > 0).slice(0, 6)
        : [];
      if (options.length >= 2) {
        const hours = Number(poll.closesInHours);
        pollData = {
          question: poll.question.trim().slice(0, 200),
          closesAt: Number.isFinite(hours) && hours > 0
            ? new Date(Date.now() + Math.min(hours, 24 * 365) * 3600 * 1000)
            : null,
          options: options.map((o: string) => o.slice(0, 120)),
        };
      }
    }

    /**
     * A post needs an author and SOMETHING to show — text or media, not
     * necessarily both.
     *
     * This used to require `content`, so posting a GIF on its own was rejected
     * with "Missing required fields". That is the normal way people post a
     * reaction image, and it was impossible.
     */
    const hasText = typeof content === "string" && content.trim().length > 0;
    const hasMedia = typeof mediaUrl === "string" && mediaUrl.trim().length > 0;

    // A poll on its own is a post too — the question IS the content.
    if (!userId || (!hasText && !hasMedia && !pollData)) {
      return res.status(400).json({ success: false, message: "Write something, attach an image, or add a poll." });
    }

    const comment = await prisma.comment.create({
      data: {
        userId,
        content,
        animeId: animeId ? parseInt(animeId) : null,
        animeTitle: animeTitle ? animeTitle : null,
        // Coerced and sanity-checked here, not trusted: the client sends a
        // number but a bad one would produce a link to an episode that
        // doesn't exist. Anything non-positive or non-finite stores as null
        // and falls back to the series page.
        episodeNo: (() => {
          const n = Number(episodeNo);
          return Number.isInteger(n) && n > 0 && n < 100000 ? n : null;
        })(),
        mangaId: mangaId || null,
        mangaTitle: mangaTitle || null,
        chapterId: chapterId ? String(chapterId) : null,
        chapterTitle: chapterTitle || null,
        novelId: novelId || null,
        novelTitle: novelTitle || null,
        guildId: guildIdValue,
        parentId: parentId ? parentId : null,
        mediaUrl: mediaUrl || null,
        // Trimmed and capped here, not just in the composer — the client is not
        // the length check, and a 30-char field is the only thing keeping a
        // headline from becoming a second body.
        title: typeof title === "string" && title.trim() ? title.trim().slice(0, 30) : null,
        tag: FORUM_TAGS.includes(tag) ? tag : null,
        ...(pollData
          ? {
              poll: {
                create: {
                  question: pollData.question,
                  closesAt: pollData.closesAt,
                  options: { create: pollData.options.map((text, i) => ({ text, order: i })) },
                },
              },
            }
          : {}),
      },
      /**
       * Must mirror getComments' shape exactly. The client prepends this object
       * straight into the rendered list, so anything getComments provides and
       * this doesn't is simply missing on the just-posted comment — it rendered
       * with no rank colour, no frame, no effect and no score until a refresh.
       */
      include: {
        // Shared with the read paths. This copy was missing role and
        // purchasedTags, so a just-posted comment rendered without its author's
        // staff or donor badge and only grew one on the next refresh.
        user: { select: COMMENT_AUTHOR_SELECT },
        votes: true,
        poll: { include: { options: { orderBy: { order: "asc" as const } }, votes: true } },
      }
    });

    // Award Arise Points + XP for posting a view/review
    const commentPayout = payout("comment");
    await prisma.user.update({
      where: { id: userId },
      data: { arisePoints: { increment: commentPayout.ap }, xp: { increment: commentPayout.xp } }
    });

    if (parentId) {
      const parent = await prisma.comment.findUnique({ where: { id: parentId } });
      if (parent && parent.userId !== userId) {
        const actor = await prisma.user.findUnique({ where: { id: userId } });
        if (actor) {
          await prisma.notification.create({
            data: {
              userId: parent.userId,
              actorId: userId,
              type: "reply",
              message: `${actor.username} replied to your comment.`,
              // The parent decides the page (it may be a forum root); the new
              // reply is the anchor, so the click lands ON the reply.
              link: commentDeepLink(parent, comment.id)
            }
          });
        }
      }
    }
    
    await prisma.pointLog.create({
      data: { userId, amount: 1, reason: "Shared your views with the community" }
    });

    // Process @mentions in the comment content
    const commentLink = commentDeepLink(comment);
    await processMentions(content, userId, commentLink);

    // Shaped exactly like the feed's rows — the client prepends this object
    // straight into the list, so a differently-shaped reply renders a
    // just-posted item with no poll and no tallies until a refresh.
    res.status(201).json({ success: true, data: shapeComment(comment, userId) });
  } catch (error) {
    next(error);
  }
};

export const deleteComment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    // Identity comes from the VERIFIED token, never req.body.userId — that was
    // unauthenticated client input, so anyone knowing a staff id could moderate.
    const actor = await resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const userId = actor.id;

    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment) {
      return res.status(404).json({ success: false, message: "Comment not found" });
    }

    if (comment.userId !== userId && !actor.isStaff) {
      // Guild leaders and co-leaders moderate their own board — and ONLY
      // their own. Scoped to comments that carry that guild's id, so the
      // power grants nothing over public threads or other guilds' boards.
      let leaderModerates = false;
      if (comment.guildId) {
        const guild = await prisma.guild.findUnique({
          where: { id: comment.guildId },
          select: { leaderId: true, coLeaderId: true },
        });
        leaderModerates = !!guild && (guild.leaderId === userId || guild.coLeaderId === userId);
      }
      if (!leaderModerates) {
        return res.status(403).json({ success: false, message: "You can only delete your own comments" });
      }
    }

    await prisma.comment.delete({ where: { id } });
    
    // Claw back the same reward the comment granted, so create+delete can't
    // be used to farm points/XP.
    const commentPayout = payout("comment");
    await prisma.user.update({
      where: { id: comment.userId },
      data: { arisePoints: { decrement: commentPayout.ap }, xp: { decrement: commentPayout.xp } }
    });

    await prisma.pointLog.create({
      data: { userId: comment.userId, amount: -commentPayout.ap, reason: "Community view was deleted" }
    });

    res.json({ success: true, message: "Comment deleted" });
  } catch (error) {
    next(error);
  }
};

export const voteComment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    // Token identity wins; req.body.userId stays only so sessions issued
    // before this still work. This was the last comment endpoint trusting the
    // body outright.
    const actor = await resolveActor(req);
    const userId: string | undefined = actor?.id || (req.body?.userId as string | undefined);
    const raw = Number(req.body?.value);

    if (!userId || !Number.isFinite(raw)) {
      return res.status(400).json({ success: false, message: "Invalid payload" });
    }

    // CLAMPED, because the global ranking is a SUM of these. The old check was
    // `typeof value === 'number'` and the value was written verbatim, so a
    // single crafted request with value: 9999 outranked every comment on the
    // site permanently — and showed up in neither the like nor the dislike
    // tally, since those count exactly 1 and -1.
    const value = raw > 0 ? 1 : raw < 0 ? -1 : 0;

    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    const existingVote = await prisma.commentVote.findUnique({
      where: { commentId_userId: { commentId: id, userId } }
    });

    const oldScore = existingVote ? existingVote.value : 0;
    const newScore = value;

    // Only award points if the voter is NOT the author of the comment
    if (comment.userId !== userId) {
      if (newScore === 1 && oldScore <= 0) {
        // User changed vote to upvote OR upvoted for the first time
        await prisma.user.update({
          where: { id: comment.userId },
          data: { arisePoints: { increment: 2 } }
        });
        await prisma.pointLog.create({
          data: { userId: comment.userId, amount: 2, reason: "Your comment received an upvote" }
        });

        const actor = await prisma.user.findUnique({ where: { id: userId } });
        if (actor) {
          await prisma.notification.create({
            data: {
              userId: comment.userId,
              actorId: userId,
              type: "like",
              message: `${actor.username} liked your comment.`,
              link: commentDeepLink(comment)
            }
          });
        }
      } else if (oldScore === 1 && newScore !== 1) {
        /**
         * Give back exactly what was given. This used to award 2 on an upvote
         * and reclaim only 1 when it was withdrawn, so toggling the same
         * upvote on and off MINTED a point to the author every cycle — free
         * Arise Points for anyone willing to click twice.
         *
         * It also only fired on newScore === 0, so switching straight from
         * upvote to DOWNVOTE kept the +2 as well.
         */
        await prisma.user.update({ where: { id: comment.userId }, data: { arisePoints: { decrement: 2 } } });
        await prisma.pointLog.create({ data: { userId: comment.userId, amount: -2, reason: "Upvote removed from your comment" } });
      }
    }

    if (value === 0) {
      await prisma.commentVote.deleteMany({
        where: { commentId: id, userId }
      });
    } else {
      await prisma.commentVote.upsert({
        where: {
          commentId_userId: { commentId: id, userId }
        },
        update: { value },
        create: {
          commentId: id,
          userId,
          value
        }
      });
    }

    res.json({ success: true, message: "Vote registered" });
  } catch (error) {
    next(error);
  }
};

// Tip a comment: send a small, fixed amount of Arise Points to its author.
// One tip per person per comment. Circulates the currency and rewards good posts.
export const tipComment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: "Missing userId" });

    const TIP_AMOUNT = 10;

    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    if (comment.userId === userId) {
      return res.status(400).json({ success: false, message: "You can't tip your own comment." });
    }

    const tipper = await prisma.user.findUnique({ where: { id: userId } });
    if (!tipper) return res.status(404).json({ success: false, message: "User not found" });

    // One tip per person per comment (deduped via the point log reason).
    const already = await prisma.pointLog.findFirst({ where: { userId, reason: `tip:${id}` } });
    if (already) return res.status(409).json({ success: false, message: "You already tipped this comment." });

    if (tipper.arisePoints < TIP_AMOUNT) {
      return res.status(402).json({ success: false, message: `You need ${TIP_AMOUNT} Arise Points to tip.` });
    }

    // Move the points from tipper -> author and log both sides.
    const updatedTipper = await prisma.user.update({ where: { id: userId }, data: { arisePoints: { decrement: TIP_AMOUNT } } });
    await prisma.user.update({ where: { id: comment.userId }, data: { arisePoints: { increment: TIP_AMOUNT } } });
    await prisma.pointLog.create({ data: { userId, amount: -TIP_AMOUNT, reason: `tip:${id}` } });
    await prisma.pointLog.create({ data: { userId: comment.userId, amount: TIP_AMOUNT, reason: "Your comment was tipped" } });

    await prisma.notification.create({
      data: {
        userId: comment.userId,
        actorId: userId,
        type: "tip",
        message: `${tipper.username} tipped your comment ${TIP_AMOUNT} Arise Points!`,
        link: commentDeepLink(comment),
      },
    });

    res.json({ success: true, tip: TIP_AMOUNT, arisePoints: updatedTipper.arisePoints });
  } catch (error) {
    next(error);
  }
};

// Divine Blessing: an admin / lead dev grants a fixed gift of Arise Points to a
// comment's author and marks the comment as blessed. Admins only; once per comment.
export const blessComment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const BLESSING_AMOUNT = 500;

    // This MINTS currency, so it is a hard staff gate on the verified token.
    // It previously trusted req.body.userId, meaning anyone who knew a staff
    // user id could print 500 Arise Points at will.
    const admin = await requireStaff(req, res);
    if (!admin) return;
    const userId = admin.id;

    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });
    if ((comment as any).blessed) return res.status(409).json({ success: false, message: "This comment has already received a Divine Blessing." });

    // Grant the blessing to the author, mark the comment, log it, and notify.
    const author = await prisma.user.update({ where: { id: comment.userId }, data: { arisePoints: { increment: BLESSING_AMOUNT } } });
    await prisma.comment.update({ where: { id }, data: { blessed: true } as any });
    await prisma.pointLog.create({ data: { userId: comment.userId, amount: BLESSING_AMOUNT, reason: "Divine Blessing" } });

    await prisma.notification.create({
      data: {
        userId: comment.userId,
        actorId: userId,
        type: "blessing",
        message: `${admin.username} granted your comment a Divine Blessing — +${BLESSING_AMOUNT} Arise Points!`,
        link: commentDeepLink(comment),
      },
    });

    res.json({ success: true, blessing: BLESSING_AMOUNT, authorArisePoints: author.arisePoints });
  } catch (error) {
    next(error);
  }
};

export const editComment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { content, mediaUrl, title, tag } = req.body;

    if (!content) {
      return res.status(400).json({ success: false, message: "Invalid payload" });
    }

    // Verified identity only — never req.body.userId.
    const actor = await resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const userId = actor.id;

    const comment = await prisma.comment.findUnique({ where: { id }, include: { user: true } });
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    if (comment.userId !== userId && !actor.isStaff) {
      return res.status(403).json({ success: false, message: "Not authorized to edit this comment" });
    }

    const updatedComment = await prisma.comment.update({
      where: { id },
      data: {
        content,
        mediaUrl: mediaUrl || null,
        // Forum posts carry a headline and a topic. Without these an author
        // could fix a typo in the body but was stuck with the title forever.
        // `undefined` leaves a field alone, so a plain comment edit — which
        // sends neither — is completely unaffected.
        ...(typeof title === "string"
          ? { title: title.trim() ? title.trim().slice(0, 30) : null }
          : {}),
        ...(typeof tag === "string" && FORUM_TAGS.includes(tag) ? { tag } : {}),
      },
      include: {
        // Same badge fields as the read paths: the client swaps the edited
        // node in wholesale, so a thinner select here makes a user's badges
        // vanish the moment they fix a typo.
        //
        // That is not hypothetical — this select really did carry six fields
        // while claiming parity, so editing a comment dropped the author's
        // rank colour, frame, effect and every cosmetic badge until a refresh.
        // Sharing the constant is what makes the claim above true.
        user: { select: COMMENT_AUTHOR_SELECT },
        votes: true
      }
    });

    res.json({ success: true, data: updatedComment });
  } catch (error) {
    next(error);
  }
};

export const togglePinComment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    // A pin floats a comment to the top of every thread site-wide — staff only,
    // proven by the verified token rather than a body-supplied userId.
    const actor = await requireStaff(req, res);
    if (!actor) return;

    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    const updatedComment = await prisma.comment.update({
      where: { id },
      data: { isPinned: !comment.isPinned }
    });

    res.json({ success: true, data: updatedComment, message: updatedComment.isPinned ? "Comment pinned" : "Comment unpinned" });
  } catch (error) {
    next(error);
  }
};



// ── GET /api/comments/:id ─────────────────────────────────────────────────
// One post with its replies, for a permalink page. Without this a detail
// route has to pull a whole feed page and hope its post is in it — which
// fails for anything older than page one.
export const getCommentById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const userId = req.query.userId as string | undefined;

    // The shared author select — this local copy was the closest to correct of
    // the five, which is exactly why it is worth deleting: "closest to correct"
    // is how the other four drifted without anyone noticing.
    const USER_SELECT = COMMENT_AUTHOR_SELECT;

    const post: any = await prisma.comment.findUnique({
      where: { id },
      include: {
        user: { select: USER_SELECT },
        votes: true,
        poll: { include: { options: { orderBy: { order: "asc" as const } }, votes: true } },
      },
    });
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    // Replies, four generations deep — the same depth the feed hydrates.
    const rows: any[] = [];
    let parents: string[] = [post.id];
    for (let i = 0; i < 4; i++) {
      if (parents.length === 0) break;
      const replies: any[] = await prisma.comment.findMany({
        where: { parentId: { in: parents } },
        include: {
          user: { select: USER_SELECT },
          votes: true,
          poll: { include: { options: { orderBy: { order: "asc" as const } }, votes: true } },
        },
      });
      if (replies.length === 0) break;
      rows.push(...replies);
      parents = replies.map((r: any) => r.id);
    }

    res.json({
      success: true,
      data: {
        post: shapeComment(post, userId),
        replies: rows.map((r: any) => shapeComment(r, userId)),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/polls/:id/vote ──────────────────────────────────────────────
// Cast or change your vote. One row per member per poll (unique), so voting
// again MOVES your vote rather than adding a second one.
export const votePoll = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pollId = req.params.id as string;
    const optionId = req.body?.optionId as string | undefined;

    // Verified identity only — a body-supplied id could be rotated through
    // every user id the public feed hands out, which is exactly how you
    // stuff a poll.
    const actor = await resolveActor(req);
    if (!actor) return res.status(401).json({ success: false, message: "Sign in again to vote." });
    if (!optionId) return res.status(400).json({ success: false, message: "optionId is required" });

    const poll: any = await prisma.poll.findUnique({
      where: { id: pollId },
      include: { options: true },
    });
    if (!poll) return res.status(404).json({ success: false, message: "Poll not found" });
    if (poll.closesAt && new Date(poll.closesAt).getTime() <= Date.now()) {
      return res.status(400).json({ success: false, message: "This poll has closed." });
    }
    if (!poll.options.some((o: any) => o.id === optionId)) {
      return res.status(400).json({ success: false, message: "That option isn't on this poll." });
    }

    await prisma.pollVote.upsert({
      where: { pollId_userId: { pollId, userId: actor.id } },
      update: { optionId },
      create: { pollId, optionId, userId: actor.id },
    });

    const votes = await prisma.pollVote.findMany({ where: { pollId }, select: { optionId: true, userId: true } });
    res.json({
      success: true,
      data: {
        totalVotes: votes.length,
        myOptionId: optionId,
        options: poll.options
          .sort((a: any, b: any) => a.order - b.order)
          .map((o: any) => ({ id: o.id, text: o.text, votes: votes.filter((v) => v.optionId === o.id).length })),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/comments/:id/report ─────────────────────────────────────────
// Flag a comment. One row per member per comment (unique), so tapping twice
// can't inflate the count; staff read the counts straight from the table.
export const reportComment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Cast, don't destructure: this Express version types req.params values
    // as `string | string[]`, which Prisma's where/create inputs reject. The
    // other handlers in this file all take the same shape.
    const id = req.params.id as string;
    // Identity from the VERIFIED token, never req.body.userId — the whole
    // point of the unique row is "one report per member", and a body-supplied
    // id can be rotated through every user id the public feed hands out,
    // filing reports under innocent names.
    const actor = await resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const userId = actor.id;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 300) : null;

    const comment = await prisma.comment.findUnique({ where: { id }, select: { id: true, userId: true } });
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });
    if (comment.userId === userId) {
      return res.status(400).json({ success: false, message: "You can't report your own comment" });
    }

    await prisma.commentReport.upsert({
      where: { commentId_userId: { commentId: id, userId } },
      update: { reason },
      create: { commentId: id, userId, reason },
    });

    const count = await prisma.commentReport.count({ where: { commentId: id } });
    res.json({ success: true, message: "Reported. Thanks — staff will take a look.", count });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/ratings?targetKey=&userId= ───────────────────────────────────
// The community's average score for one thing, plus the caller's own score.
// targetKey is opaque: "anime:21", "manhwa:<slug>:<chapterId>", "novel:<id>".
export const getRating = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetKey = req.query.targetKey as string | undefined;
    const userId = req.query.userId as string | undefined;
    if (!targetKey) return res.status(400).json({ success: false, message: "targetKey is required" });

    const agg = await prisma.rating.aggregate({
      where: { targetKey },
      _avg: { value: true },
      _count: { _all: true },
    });

    let mine: number | null = null;
    if (userId) {
      const row = await prisma.rating.findUnique({
        where: { userId_targetKey: { userId, targetKey } },
        select: { value: true },
      });
      mine = row ? row.value : null;
    }

    res.json({
      success: true,
      data: {
        average: agg._avg.value != null ? Math.round(agg._avg.value * 10) / 10 : null,
        count: agg._count._all,
        mine,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/ratings ─────────────────────────────────────────────────────
// Score something 1-10. Rating again REPLACES your score rather than adding
// another row, so the average can never be stuffed by one member.
export const setRating = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Verified identity only. "One score per member" is the entire defence
    // against a stuffed average, and it's worthless if the caller picks the
    // member — real user ids are readable from any public comment feed.
    const actor = await resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to rate." });
    }
    const userId = actor.id;
    const targetKey = req.body?.targetKey as string | undefined;
    const raw = Number(req.body?.value);
    if (!targetKey) {
      return res.status(400).json({ success: false, message: "targetKey is required" });
    }
    if (!Number.isFinite(raw) || raw < 1 || raw > 10) {
      return res.status(400).json({ success: false, message: "value must be 1-10" });
    }
    const value = Math.round(raw);

    await prisma.rating.upsert({
      where: { userId_targetKey: { userId, targetKey } },
      update: { value },
      create: { userId, targetKey, value },
    });

    const agg = await prisma.rating.aggregate({
      where: { targetKey },
      _avg: { value: true },
      _count: { _all: true },
    });

    res.json({
      success: true,
      data: {
        average: agg._avg.value != null ? Math.round(agg._avg.value * 10) / 10 : null,
        count: agg._count._all,
        mine: value,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/comments/topics ──────────────────────────────────────────────
// Post counts per topic for the forum sidebar. A groupBy is one query; the
// alternative is fetching every post just to count them client-side, which
// gets worse with every post ever written.
export const getForumTopics = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const base = { animeId: null, mangaId: null, chapterId: null, novelId: null, guildId: null, parentId: null };
    const [rows, total] = await Promise.all([
      prisma.comment.groupBy({ by: ["tag"], where: base, _count: { _all: true } }),
      prisma.comment.count({ where: base }),
    ]);
    const counts: Record<string, number> = {};
    for (const r of rows) if (r.tag) counts[r.tag] = r._count._all;
    res.json({
      success: true,
      data: {
        total,
        topics: FORUM_TAGS.map((t) => ({ tag: t, count: counts[t] || 0 })),
      },
    });
  } catch (error) {
    next(error);
  }
};
