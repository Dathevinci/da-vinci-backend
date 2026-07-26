import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { processMentions } from "../utils/mentions";
import { payout } from "../utils/economy";
import { resolveActor, requireStaff } from "../lib/staff";

export const getComments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const animeId = req.query.animeId as string | undefined;
    const mangaId = req.query.mangaId as string | undefined;
    const chapterId = req.query.chapterId as string | undefined;
    const novelId = req.query.novelId as string | undefined;

    const userId = req.query.userId as string | undefined;
    const sort = req.query.sort as string | undefined;
    const search = req.query.search as string | undefined;
    const mediaOnly = req.query.mediaOnly === 'true';
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const skip = (page - 1) * limit;

    const where: any = {};
    if (animeId) where.animeId = parseInt(animeId);
    if (mangaId) where.mangaId = mangaId;
    if (chapterId) where.chapterId = chapterId;
    if (novelId) where.novelId = novelId; // novel comments are novel-level (no chapters)
    if (!animeId && mangaId && !chapterId) {
      where.chapterId = null; // When viewing manhwa top-level, exclude chapter-specific comments
    }
    
    if (search) where.content = { contains: search, mode: 'insensitive' };
    if (mediaOnly) where.mediaUrl = { not: null };

    // To keep threads intact, paginate only root comments unless searching/filtering
    if (!search && !mediaOnly) {
       where.parentId = null;
    }

    const COMMENT_INCLUDE = {
      user: { select: { id: true, username: true, avatar: true, arisePoints: true, xp: true, activeRole: true, activeTag: true, activeEffect: true, activeTheme: true, activeColor: true, activeFont: true, activeFrame: true } },
      votes: true,
    };

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
        const sa = a.votes.reduce((acc, v) => acc + v.value, 0);
        const sb = b.votes.reduce((acc, v) => acc + v.value, 0);
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
        orderBy: { createdAt: sort === 'oldest' ? 'asc' : 'desc' },
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
              user: { select: { id: true, username: true, avatar: true, arisePoints: true, xp: true, activeRole: true, activeTag: true, activeEffect: true, activeTheme: true, activeColor: true, activeFont: true, activeFrame: true } },
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
    const formattedComments = allComments.map(comment => {
      const score = comment.votes.reduce((acc, vote) => acc + vote.value, 0);
      const userVote = userId ? comment.votes.find(v => v.userId === userId)?.value || 0 : 0;
      
      return {
        ...comment,
        score,
        userVote,
        votes: undefined // hide raw votes array to save bandwidth
      };
    });

    res.json({ success: true, data: formattedComments });
  } catch (error) {
    next(error);
  }
};

export const createComment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, animeId, animeTitle, mangaId, mangaTitle, chapterId, chapterTitle, novelId, novelTitle, content, parentId, mediaUrl } = req.body;

    if (!userId || !content) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const comment = await prisma.comment.create({
      data: {
        userId,
        content,
        animeId: animeId ? parseInt(animeId) : null,
        animeTitle: animeTitle ? animeTitle : null,
        mangaId: mangaId || null,
        mangaTitle: mangaTitle || null,
        chapterId: chapterId ? String(chapterId) : null,
        chapterTitle: chapterTitle || null,
        novelId: novelId || null,
        novelTitle: novelTitle || null,
        parentId: parentId ? parentId : null,
        mediaUrl: mediaUrl || null,
      },
      include: {
        user: { select: { id: true, username: true, avatar: true, arisePoints: true } },
        votes: true,
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
              link: animeId ? `/community?view=${animeId}&tab=discussions` : `/community`
            }
          });
        }
      }
    }
    
    await prisma.pointLog.create({
      data: { userId, amount: 1, reason: "Shared your views with the community" }
    });

    // Process @mentions in the comment content
    const commentLink = animeId ? `/community?view=${animeId}&tab=discussions` : `/community`;
    await processMentions(content, userId, commentLink);

    res.status(201).json({ success: true, data: { ...comment, score: 0, userVote: 0, votes: undefined } });
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
      return res.status(403).json({ success: false, message: "You can only delete your own comments" });
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
    const { userId, value } = req.body;

    if (!userId || typeof value !== 'number') {
      return res.status(400).json({ success: false, message: "Invalid payload" });
    }

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
              link: comment.animeId ? `/community?view=${comment.animeId}&tab=discussions` : `/community`
            }
          });
        }
      } else if (newScore === 0 && oldScore === 1) {
        // Deduct point if upvote is removed
        await prisma.user.update({ where: { id: comment.userId }, data: { arisePoints: { decrement: 1 } } });
        await prisma.pointLog.create({ data: { userId: comment.userId, amount: -1, reason: "Upvote removed from your comment" } });
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
        link: comment.animeId ? `/community?view=${comment.animeId}&tab=discussions` : `/community`,
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
        link: comment.animeId ? `/community?view=${comment.animeId}&tab=discussions` : `/community`,
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
    const { content, mediaUrl } = req.body;

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
      data: { content, mediaUrl: mediaUrl || null },
      include: {
        user: { select: { id: true, username: true, avatar: true, arisePoints: true } },
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


