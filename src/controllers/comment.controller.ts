import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

export const getComments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const animeId = req.query.animeId as string | undefined;
    const userId = req.query.userId as string | undefined;

    const comments = await prisma.comment.findMany({
      where: {
        ...(animeId ? { animeId: parseInt(animeId) } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, username: true, avatar: true, arisePoints: true } },
        votes: true,
      }
    });

    // Format the response to include the calculated score and the current user's vote
    const formattedComments = comments.map(comment => {
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
    const { userId, animeId, animeTitle, content, parentId } = req.body;

    if (!userId || !content) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const comment = await prisma.comment.create({
      data: {
        userId,
        content,
        animeId: animeId ? parseInt(animeId) : null,
        animeTitle: animeTitle ? animeTitle : null,
        parentId: parentId ? parentId : null,
      },
      include: {
        user: { select: { id: true, username: true, avatar: true, arisePoints: true } },
        votes: true,
      }
    });

    // Award 1 Arise Points for posting a view/review
    await prisma.user.update({
      where: { id: userId },
      data: { arisePoints: { increment: 1 } }
    });
    
    await prisma.pointLog.create({
      data: { userId, amount: 1, reason: "Shared your views with the community" }
    });

    res.status(201).json({ success: true, data: { ...comment, score: 0, userVote: 0, votes: undefined } });
  } catch (error) {
    next(error);
  }
};

export const deleteComment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const userId = req.body.userId as string; // In a real app, this should come from a verified JWT token

    const comment = await prisma.comment.findUnique({ where: { id } });

    if (!comment) {
      return res.status(404).json({ success: false, message: "Comment not found" });
    }

    if (comment.userId !== userId) {
      return res.status(403).json({ success: false, message: "You can only delete your own comments" });
    }

    await prisma.comment.delete({ where: { id } });
    
    // Deduct the 1 points they got from posting
    await prisma.user.update({
      where: { id: userId },
      data: { arisePoints: { decrement: 1 } }
    });

    await prisma.pointLog.create({
      data: { userId, amount: -1, reason: "Deleted a community view" }
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
        // Award point to AUTHOR for new upvote
        await prisma.user.update({ where: { id: comment.userId }, data: { arisePoints: { increment: 1 } } });
        await prisma.pointLog.create({ data: { userId: comment.userId, amount: 1, reason: "Received an upvote on your comment" } });
      } else if (oldScore === 1 && newScore <= 0) {
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
