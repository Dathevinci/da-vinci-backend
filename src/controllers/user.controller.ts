import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

export const createUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, email } = req.body;
    const user = await prisma.user.create({
      data: { username, email },
    });
    res.status(201).json({ success: true, data: user });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ success: false, message: "Username or email already exists" });
    }
    next(error);
  }
};

export const getUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id as string },
      include: { watchlist: true },
    });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};
