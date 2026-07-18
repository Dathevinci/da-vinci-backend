import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

// Public anime likes. Independent from the watchlist so an anime can be both
// liked and tracked. Likes appear on the user's public profile.

export const addLike = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await prisma.animeLike.create({ data: req.body });
    res.status(201).json({ success: true, data: item });
  } catch (error: any) {
    // Already liked — treat as success (idempotent) rather than an error.
    if (error.code === "P2002") {
      return res.status(200).json({ success: true, message: "Already liked" });
    }
    next(error);
  }
};

export const getLikes = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await prisma.animeLike.findMany({
      where: { userId: req.params.userId as string },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: list });
  } catch (error) {
    next(error);
  }
};

export const removeLike = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const anilistId = parseInt(req.params.anilistId as string, 10);
    await prisma.animeLike.deleteMany({
      where: { userId: req.params.userId as string, anilistId },
    });
    res.json({ success: true, message: "Like removed" });
  } catch (error) {
    next(error);
  }
};
