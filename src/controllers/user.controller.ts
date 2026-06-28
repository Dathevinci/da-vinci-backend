import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

export const createUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const username = req.body.username?.trim();
    const email = req.body.email?.trim();
    
    // DEV Account Override for 'dejavuh'
    if (username && username.toLowerCase() === 'dejavuh') {
      let devUser = await prisma.user.findFirst({
        where: { username: { equals: 'dejavuh', mode: 'insensitive' } }
      });
      
      if (devUser) {
        // Log them in immediately, bypassing email strict check
        return res.status(200).json({ success: true, data: devUser });
      } else {
        devUser = await prisma.user.create({
          data: { username: 'dejavuh', email: email || 'dejavuh@davinci.dev' },
        });
        return res.status(201).json({ success: true, data: devUser });
      }
    }

    // Try to find existing user first (mock login)
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: username, mode: 'insensitive' } },
          { email: { equals: email, mode: 'insensitive' } }
        ]
      }
    });

    if (user) {
      if (user.username.toLowerCase() !== username?.toLowerCase() || user.email.toLowerCase() !== email?.toLowerCase()) {
        return res.status(400).json({ success: false, message: "Username or email is taken by someone else." });
      }
      // "Login" successful
      return res.status(200).json({ success: true, data: user });
    }

    // Register new user
    user = await prisma.user.create({
      data: { username, email },
    });
    res.status(201).json({ success: true, data: user });
  } catch (error: any) {
    next(error);
  }
};

export const getUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id as string },
      include: { 
        watchlist: true,
        followers: { include: { follower: true } },
        following: { include: { following: true } }
      },
    });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

export const updateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, email, avatar, bannerUrl, bio } = req.body;
    
    const user = await prisma.user.update({
      where: { id: req.params.id as string },
      data: {
        ...(username && { username }),
        ...(email && { email }),
        ...(avatar !== undefined && { avatar }),
        ...(bannerUrl !== undefined && { bannerUrl }),
        ...(bio !== undefined && { bio }),
      },
    });
    
    res.json({ success: true, data: user });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ success: false, message: "Username or email already exists" });
    }
    next(error);
  }
};

export const getUserByUsername = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { username: req.params.username as string },
      include: { 
        watchlist: true,
        followers: { include: { follower: true } },
        following: { include: { following: true } } 
      },
    });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

export const getAllUsers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        followers: { include: { follower: true } },
        following: { include: { following: true } }
      }
    });
    res.json({ success: true, data: users });
  } catch (error) {
    next(error);
  }
};

export const followUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { followerId } = req.body; // The user who is doing the following
    const followingId = req.params.id as string; // The user being followed

    if (followerId === followingId) {
      return res.status(400).json({ success: false, message: "Cannot follow yourself" });
    }

    const follow = await prisma.follow.create({
      data: {
        followerId,
        followingId
      }
    });
    
    // Get the follower's username to put in the notification message
    const follower = await prisma.user.findUnique({ where: { id: followerId } });
    if (follower) {
      await prisma.notification.create({
        data: {
          userId: followingId,
          actorId: followerId,
          type: "NEW_FOLLOWER",
          message: `${follower.username} started following you!`,
          link: `/user/${follower.username}`
        }
      });
    }
    
    res.json({ success: true, data: follow });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ success: false, message: "Already following" });
    }
    next(error);
  }
};

export const unfollowUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { followerId } = req.body;
    const followingId = req.params.id as string;

    await prisma.follow.delete({
      where: {
        followerId_followingId: {
          followerId,
          followingId
        }
      }
    });
    
    res.json({ success: true, message: "Unfollowed successfully" });
  } catch (error) {
    next(error);
  }
};
