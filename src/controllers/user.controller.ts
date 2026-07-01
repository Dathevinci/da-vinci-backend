import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER || "siddharthashahthakuri447@gmail.com",
    pass: process.env.GMAIL_APP_PASSWORD || "", // Must be provided in .env
  },
});

const sendWelcomeEmail = async (email: string, username: string) => {
  try {
    if (!process.env.GMAIL_APP_PASSWORD) return;
    await transporter.sendMail({
      from: `"Da Vinci Anime Tracker" <${process.env.GMAIL_USER || "siddharthashahthakuri447@gmail.com"}>`,
      to: email,
      subject: "Welcome to Da-vinci anime tracker!",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f0f11; color: #fff; padding: 20px; border-radius: 10px;">
          <h1 style="color: #6366f1; text-align: center;">Welcome to Da Vinci, ${username}!</h1>
          <p style="font-size: 16px; line-height: 1.5; color: #cbd5e1;">
            We are thrilled to have you join our anime tracking community. Your journey begins now.
          </p>
          <div style="background-color: #1e1e24; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #d946ef;">
            <p style="margin: 0; font-size: 16px; color: #f8fafc; font-style: italic;">
              "Tracking your anime shouldn't feel like a chore. Welcome to the smoothest experience on the web."
            </p>
            <p style="margin-top: 10px; font-size: 14px; color: #94a3b8; font-weight: bold;">
              — Message from Lead Dev
            </p>
          </div>
          <p style="font-size: 14px; color: #64748b; text-align: center; margin-top: 30px;">
            Da Vinci Anime Tracker &copy; ${new Date().getFullYear()}
          </p>
        </div>
      `,
    });
  } catch (error) {
    console.error("Error sending welcome email:", error);
  }
};

export const createUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const username = req.body.username?.trim();
    const email = req.body.email?.trim();
    
    // DEV Account Override for 'dejavuh'
    if (username && username.toLowerCase() === 'dejavuh') {
      let devUser = await prisma.user.findFirst({
        where: { username: { equals: 'dejavuh', mode: 'insensitive' } },
        include: { followers: { include: { follower: true } }, following: { include: { following: true } } }
      });
      
      if (devUser) {
        // Log them in immediately, bypassing email strict check
        return res.status(200).json({ success: true, data: devUser });
      } else {
        devUser = await prisma.user.create({
          data: { username: 'dejavuh', email: email || 'dejavuh@davinci.dev' },
          include: { followers: { include: { follower: true } }, following: { include: { following: true } } }
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
      },
      include: { followers: { include: { follower: true } }, following: { include: { following: true } } }
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
      include: { followers: { include: { follower: true } }, following: { include: { following: true } } }
    });
    
    // Send welcome email asynchronously
    sendWelcomeEmail(user.email, user.username);
    
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
    const { username, email, avatar, bannerUrl, bio, arisePoints, isPrivate, theme } = req.body;
    const userId = req.params.id as string;
    
    let incrementPoints = 0;

    // Check for Avatar update reward
    if (avatar) {
      const existingNotif = await prisma.notification.findFirst({
        where: { userId, actorId: userId, type: "ARISE_POINTS_AVATAR" }
      });
      if (!existingNotif) {
        incrementPoints += 2;
        await prisma.notification.create({
          data: { userId, actorId: userId, type: "ARISE_POINTS_AVATAR", message: "You earned 2 Arise Points for updating your Profile Picture!", link: `/profile` }
        });
        await prisma.pointLog.create({
          data: { userId, amount: 2, reason: "Updated Profile Picture" }
        });
      }
    }

    // Check for Banner update reward
    if (bannerUrl) {
      const existingNotif = await prisma.notification.findFirst({
        where: { userId, actorId: userId, type: "ARISE_POINTS_BANNER" }
      });
      if (!existingNotif) {
        incrementPoints += 2;
        await prisma.notification.create({
          data: { userId, actorId: userId, type: "ARISE_POINTS_BANNER", message: "You earned 2 Arise Points for updating your Banner!", link: `/profile` }
        });
        await prisma.pointLog.create({
          data: { userId, amount: 2, reason: "Updated Banner Image" }
        });
      }
    }

    const updateData: any = {
      ...(username && { username }),
      ...(email && { email }),
      ...(avatar !== undefined && { avatar }),
      ...(bannerUrl !== undefined && { bannerUrl }),
      ...(bio !== undefined && { bio }),
      ...(arisePoints !== undefined && { arisePoints: Number(arisePoints) }),
      ...(isPrivate !== undefined && { isPrivate: Boolean(isPrivate) }),
      ...(theme !== undefined && { theme }),
    };

    if (incrementPoints > 0 && arisePoints === undefined) {
      updateData.arisePoints = { increment: incrementPoints };
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });
    
    res.json({ success: true, data: user });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ success: false, message: "Username or email already exists" });
    }
    next(error);
  }
};

export const deleteUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.id as string;
    
    await prisma.user.delete({
      where: { id: userId }
    });
    
    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    next(error);
  }
};

export const getUserByUsername = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentUserId } = req.query;
    
    const user = await prisma.user.findUnique({
      where: { username: req.params.username as string },
      include: { 
        watchlist: true,
        followers: { include: { follower: true } },
        following: { include: { following: true } } 
      },
    });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    // Privacy Filter
    if (user.isPrivate) {
      const isOwner = user.id === currentUserId;
      const isFollowingThem = user.followers.some(f => f.followerId === String(currentUserId));
      const theyAreFollowingMe = user.following.some(f => f.followingId === String(currentUserId));
      const isMutual = isFollowingThem && theyAreFollowingMe;
      
      if (!isOwner && !isMutual) {
        user.watchlist = [];
        user.bio = "This profile is private. You must mutually follow each other to see their bio, banner, and watchlist.";
        user.bannerUrl = null;
      }
    }

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

    const followingUser = await prisma.user.findUnique({ where: { id: followingId } });
    if (followingUser && followingUser.username.toLowerCase() === 'dejavuh') {
      const existingNotif = await prisma.notification.findFirst({
        where: { userId: followerId, actorId: followingId, type: "ARISE_POINTS_EARNED" }
      });

      if (!existingNotif) {
        await prisma.user.update({
          where: { id: followerId },
          data: { arisePoints: { increment: 1 } }
        });
        
        await prisma.notification.create({
          data: {
            userId: followerId,
            actorId: followingId,
            type: "ARISE_POINTS_EARNED",
            message: "You earned 1 Arise Point for following the Lead Developer!",
            link: `/user/dejavuh`
          }
        });
        
        await prisma.pointLog.create({
          data: { userId: followerId, amount: 1, reason: "Followed the Lead Developer" }
        });
      }
    }
    
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

export const getUserPointLogs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logs = await prisma.pointLog.findMany({
      where: { userId: req.params.id as string },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
};
