import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

export const addToWatchlist = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await prisma.watchlistItem.create({
      data: req.body,
    });

    const userId = req.body.userId;
    if (userId) {
      await prisma.user.update({
        where: { id: userId },
        data: { arisePoints: { increment: 1 } }
      });
      
      await prisma.notification.create({
        data: {
          userId,
          actorId: userId,
          type: "ARISE_POINTS_WATCHLIST",
          message: `You earned 2 Arise Points for adding ${req.body.title || 'an anime'} to your list!`,
          link: `/profile`
        }
      });
    }

    res.status(201).json({ success: true, data: item });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ success: false, message: "Anime already in watchlist" });
    }
    next(error);
  }
};

export const getWatchlist = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await prisma.watchlistItem.findMany({
      where: { userId: req.params.userId as string },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ success: true, data: list });
  } catch (error) {
    next(error);
  }
};

export const updateWatchlistItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await prisma.watchlistItem.update({
      where: { id: req.params.id as string },
      data: req.body,
    });
    res.json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
};

export const deleteWatchlistItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.watchlistItem.delete({
      where: { id: req.params.id as string },
    });
    res.json({ success: true, message: "Item removed" });
  } catch (error) {
    next(error);
  }
};
