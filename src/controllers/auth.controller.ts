import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import bcrypt from "bcryptjs";
import { sanitizeOwnUser } from "../utils/sanitizeUser";


export const signup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, email, password, inviteCode } = req.body;

    if (!username || !email || !password || !inviteCode) {
      return res.status(400).json({ success: false, message: "Username, email, password, and invite code are required." });
    }

    // Validate Invite Code
    const invite = await prisma.inviteCode.findUnique({
      where: { code: inviteCode.toUpperCase() },
    });

    if (!invite) {
      return res.status(400).json({ success: false, message: "Invalid invite code." });
    }
    if (invite.isUsed) {
      return res.status(400).json({ success: false, message: "This invite code has already been used." });
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: username, mode: "insensitive" } },
          { email: { equals: email, mode: "insensitive" } },
        ],
      },
    });

    if (existingUser) {
      if (existingUser.username.toLowerCase() === username.toLowerCase()) {
        return res.status(400).json({ success: false, message: "This username is already taken. Please choose another." });
      }
      return res.status(400).json({ success: false, message: "This email is already registered. Try logging in." });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
      },
      include: { followers: { include: { follower: true } }, following: { include: { following: true } } },
    });

    // Mark Invite Code as used
    await prisma.inviteCode.update({
      where: { id: invite.id },
      data: {
        isUsed: true,
        usedBy: user.id,
      },
    });


    res.status(201).json({ success: true, data: sanitizeOwnUser(user) });
  } catch (error) {
    next(error);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { identifier, password } = req.body; // identifier can be username or email

    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: "Identifier and password are required." });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: identifier, mode: "insensitive" } },
          { email: { equals: identifier, mode: "insensitive" } },
        ],
      },
      include: { followers: { include: { follower: true } }, following: { include: { following: true } } },
    });

    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid credentials." });
    }

    if (!user.password) {
      return res.status(401).json({ success: false, message: "This account was created via Discord. Please log in with Discord." });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ success: false, message: "Invalid credentials." });
    }

    res.status(200).json({ success: true, data: sanitizeOwnUser(user) });
  } catch (error) {
    next(error);
  }
};

export const changePassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, currentPassword, newPassword } = req.body;

    if (!userId || !currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    if (!user.password) {
      return res.status(400).json({ success: false, message: "Cannot change password for Discord accounts." });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Incorrect current password." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    res.json({ success: true, message: "Password updated successfully." });
  } catch (error) {
    next(error);
  }
};


