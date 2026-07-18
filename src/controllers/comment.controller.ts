import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { processMentions } from "../utils/mentions";
import { payout } from "../utils/economy";

export const getComments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const animeId = req.query.animeId as string | undefined;
    const mangaId = req.query.mangaId as string | undefined;
    const chapterId = req.query.chapterId as string | undefined;
    
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
    if (!animeId && mangaId && !chapterId) {
      where.chapterId = null; // When viewing manhwa top-level, exclude chapter-specific comments
    }
    
    if (search) where.content = { contains: search, mode: 'insensitive' };
    if (mediaOnly) where.mediaUrl = { not: null };

    // To keep threads intact, paginate only root comments unless searching/filtering
    if (!search && !mediaOnly) {
       where.parentId = null;
    }

    const comments = await prisma.comment.findMany({
      where,
      orderBy: [
        { isPinned: 'desc' },
        { createdAt: sort === 'oldest' ? 'asc' : 'desc' }
      ],
      take: limit,
      skip,
      include: {
        user: { select: { id: true, username: true, avatar: true, arisePoints: true, xp: true, activeRole: true, activeTag: true, activeEffect: true, activeTheme: true, activeColor: true, activeFont: true, activeFrame: true } },
        votes: true,
      }
    });

    let allComments = [...comments];

    // If we fetched root comments, fetch their replies recursively up to depth 4
    if (!search && !mediaOnly && comments.length > 0) {
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
    const { userId, animeId, animeTitle, mangaId, mangaTitle, chapterId, chapterTitle, content, parentId, mediaUrl } = req.body;

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
    const userId = req.body.userId as string;

    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment) {
      return res.status(404).json({ success: false, message: "Comment not found" });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const isAuthor = comment.userId === userId;
    const isAdmin = user.isAdmin || user.username.toLowerCase() === 'davinci' || user.username.toLowerCase() === 'dejavuh' || user.username.toLowerCase() === 'xhackerdevil' || user.username.toLowerCase() === 'coffee' || user.username.toLowerCase() === 'speyvenerable';

    if (!isAuthor && !isAdmin) {
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
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: "Missing userId" });

    const BLESSING_AMOUNT = 500;

    const admin = await prisma.user.findUnique({ where: { id: userId } });
    if (!admin) return res.status(404).json({ success: false, message: "User not found" });

    const isAdmin = admin.isAdmin || ["davinci", "dejavuh", "xhackerdevil", "coffee", "speyvenerable"].includes(admin.username.toLowerCase());
    if (!isAdmin) return res.status(403).json({ success: false, message: "Only admins can grant a Divine Blessing." });

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
    const { userId, content, mediaUrl } = req.body;

    if (!userId || !content) {
      return res.status(400).json({ success: false, message: "Invalid payload" });
    }

    const comment = await prisma.comment.findUnique({ where: { id }, include: { user: true } });
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const isAuthor = comment.userId === userId;
    const isAdmin = user.isAdmin || user.username.toLowerCase() === 'davinci' || user.username.toLowerCase() === 'dejavuh' || user.username.toLowerCase() === 'xhackerdevil' || user.username.toLowerCase() === 'coffee' || user.username.toLowerCase() === 'speyvenerable';

    if (!isAuthor && !isAdmin) {
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
    const { userId } = req.body;

    if (!userId) return res.status(400).json({ success: false, message: "Invalid payload" });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const isAdmin = user.isAdmin || user.username.toLowerCase() === 'davinci' || user.username.toLowerCase() === 'dejavuh' || user.username.toLowerCase() === 'xhackerdevil' || user.username.toLowerCase() === 'coffee' || user.username.toLowerCase() === 'speyvenerable';

    if (!isAdmin) {
      return res.status(403).json({ success: false, message: "Only admins can pin comments" });
    }

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


