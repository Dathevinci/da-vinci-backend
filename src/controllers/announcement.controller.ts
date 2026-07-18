import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { processMentions } from "../utils/mentions";

const prisma = new PrismaClient();

export const getAnnouncements = async (req: Request, res: Response) => {
  try {
    const announcements = await prisma.announcement.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        author: {
          select: { id: true, username: true, avatar: true, arisePoints: true, xp: true, activeEffect: true, activeFrame: true },
        },
        _count: {
          select: { likes: true, comments: true },
        },
      },
    });

    const userId = req.query.userId as string | undefined;

    const data = await Promise.all(
      announcements.map(async (announcement) => {
        let hasLiked = false;
        if (userId) {
          const like = await prisma.announcementLike.findUnique({
            where: {
              announcementId_userId: {
                announcementId: announcement.id,
                userId,
              },
            },
          });
          hasLiked = !!like;
        }

        return {
          ...announcement,
          hasLiked,
        };
      })
    );

    res.json({ success: true, data });
  } catch (err: any) {
    console.error("getAnnouncements error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

export const createAnnouncement = async (req: Request, res: Response) => {
  try {
    const { userId, title, content, tag, image } = req.body;
    
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(403).json({ success: false, error: "Unauthorized" });
    const isDev = user.username.toLowerCase() === "dejavuh";
    const isAdmin = user.isAdmin || user.username.toLowerCase() === "davinci" || user.username.toLowerCase() === "xhackerdevil" || user.username.toLowerCase() === "coffee" || user.username.toLowerCase() === "speyvenerable";
    if (!isDev && !isAdmin) {
      return res.status(403).json({ success: false, error: "Only Lead Dev and Admins can post announcements" });
    }

    const announcement = await prisma.announcement.create({
      data: {
        authorId: userId,
        title,
        content,
        tag,
        image,
      },
      include: {
        author: {
          select: { id: true, username: true, avatar: true, arisePoints: true, xp: true, activeEffect: true, activeFrame: true },
        },
        _count: {
          select: { likes: true, comments: true },
        },
      },
    });

    res.json({ success: true, data: { ...announcement, hasLiked: false } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const toggleLike = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.body.userId as string;

    if (!userId) return res.status(400).json({ success: false, error: "Missing userId" });

    const existingLike = await prisma.announcementLike.findUnique({
      where: {
        announcementId_userId: { announcementId: id, userId },
      },
    });

    if (existingLike) {
      await prisma.announcementLike.delete({ where: { id: existingLike.id } });
      res.json({ success: true, liked: false });
    } else {
      await prisma.announcementLike.create({
        data: { announcementId: id, userId },
      });

      const announcement = await prisma.announcement.findUnique({ where: { id } });
      if (announcement && announcement.authorId !== userId) {
        const actor = await prisma.user.findUnique({ where: { id: userId } });
        if (actor) {
          await prisma.notification.create({
            data: {
              userId: announcement.authorId,
              actorId: userId,
              type: "like",
              message: `${actor.username} liked your update.`,
              link: `/updates`
            }
          });
        }
      }

      res.json({ success: true, liked: true });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const getComments = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const comments = await prisma.announcementComment.findMany({
      where: { announcementId: id },
      orderBy: { createdAt: "asc" },
      include: {
        user: { select: { id: true, username: true, avatar: true, arisePoints: true, xp: true, activeEffect: true, activeFrame: true } },
      },
    });
    res.json({ success: true, data: comments });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const addComment = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.body.userId as string;
    const content = req.body.content as string;

    if (!userId || !content) {
      return res.status(400).json({ success: false, error: "Missing userId or content" });
    }

    const comment = await prisma.announcementComment.create({
      data: { announcementId: id, userId, content },
      include: {
        user: { select: { id: true, username: true, avatar: true, arisePoints: true, xp: true, activeEffect: true, activeFrame: true } },
      },
    });

    const announcement = await prisma.announcement.findUnique({ where: { id } });
    if (announcement && announcement.authorId !== userId) {
      const actor = await prisma.user.findUnique({ where: { id: userId } });
      if (actor) {
        await prisma.notification.create({
          data: {
            userId: announcement.authorId,
            actorId: userId,
            type: "reply",
            message: `${actor.username} commented on your update.`,
            link: `/updates`
          }
        });
      }
    }

    // Process @mentions in the comment content
    await processMentions(content, userId, `/updates`);

    res.json({ success: true, data: comment });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const deleteComment = async (req: Request, res: Response) => {
  try {
    const commentId = req.params.commentId as string;
    const userId = req.body.userId as string; // or forceGodMode from frontend

    const comment = await prisma.announcementComment.findUnique({
      where: { id: commentId },
      include: { user: true },
    });

    if (!comment) return res.status(404).json({ success: false, error: "Comment not found" });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const isDev = user?.username.toLowerCase() === "dejavuh";
    const isAdmin = user?.isAdmin || user?.username.toLowerCase() === "davinci" || user?.username.toLowerCase() === "xhackerdevil" || user?.username.toLowerCase() === "coffee" || user?.username.toLowerCase() === "speyvenerable";

    if (comment.userId !== userId && !isDev && !isAdmin) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    await prisma.announcementComment.delete({ where: { id: commentId } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const deleteAnnouncement = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.body.userId as string; // or forceGodMode from frontend

    const announcement = await prisma.announcement.findUnique({
      where: { id },
      include: { author: true },
    });

    if (!announcement) return res.status(404).json({ success: false, error: "Announcement not found" });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const isDev = user?.username.toLowerCase() === "dejavuh";
    const isAdmin = user?.isAdmin || user?.username.toLowerCase() === "davinci" || user?.username.toLowerCase() === "xhackerdevil" || user?.username.toLowerCase() === "coffee" || user?.username.toLowerCase() === "speyvenerable";

    if (announcement.authorId !== userId && !isDev && !isAdmin) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    await prisma.announcement.delete({ where: { id } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const editComment = async (req: Request, res: Response) => {
  try {
    const commentId = req.params.commentId as string;
    const { userId, content } = req.body;

    const comment = await prisma.announcementComment.findUnique({
      where: { id: commentId },
    });

    if (!comment) return res.status(404).json({ success: false, error: "Comment not found" });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const isDev = user?.username.toLowerCase() === "dejavuh";
    const isAdmin = user?.isAdmin || user?.username.toLowerCase() === "davinci" || user?.username.toLowerCase() === "xhackerdevil" || user?.username.toLowerCase() === "coffee" || user?.username.toLowerCase() === "speyvenerable";

    if (comment.userId !== userId && !isDev && !isAdmin) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    const updated = await prisma.announcementComment.update({
      where: { id: commentId },
      data: { content },
      include: {
        user: { select: { id: true, username: true, avatar: true, arisePoints: true, xp: true, activeEffect: true, activeFrame: true } },
      },
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const editAnnouncement = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { userId, title, content } = req.body;

    const announcement = await prisma.announcement.findUnique({
      where: { id },
    });

    if (!announcement) return res.status(404).json({ success: false, error: "Announcement not found" });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const isDev = user?.username.toLowerCase() === "dejavuh";
    const isAdmin = user?.isAdmin || user?.username.toLowerCase() === "davinci" || user?.username.toLowerCase() === "xhackerdevil" || user?.username.toLowerCase() === "coffee" || user?.username.toLowerCase() === "speyvenerable";

    if (announcement.authorId !== userId && !isDev && !isAdmin) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    const updated = await prisma.announcement.update({
      where: { id },
      data: { title, content },
      include: {
        author: {
          select: { id: true, username: true, avatar: true, arisePoints: true, xp: true, activeEffect: true, activeFrame: true },
        },
        _count: {
          select: { likes: true, comments: true },
        },
      },
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};

