import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import bcrypt from "bcryptjs";
import { sanitizeOwnUser } from "../utils/sanitizeUser";
import { signToken } from "../lib/jwt";


export const signup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    /**
     * TRIMMED AT THE DOOR. A username registered with a stray trailing space
     * ("Serena ") displays identically to the clean one, but every exact
     * lookup built from what people SEE then fails: her profile said "User
     * not found" and username login broke while email login worked — the
     * exact report that exposed this. Whitespace is invisible; identifiers
     * must never carry it.
     */
    const username = String(req.body.username ?? "").trim();
    const email = String(req.body.email ?? "").trim();
    const { password, inviteCode } = req.body;

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

    /**
     * The username collision check compares TRIMMED-lowercase on BOTH sides,
     * via raw SQL because Prisma cannot trim the stored column. Damaged rows
     * ("Serena ") predate signup trimming, and an equals-insensitive check
     * against them would let a clean "Serena" register as a second, visually
     * identical account.
     */
    const clash = await prisma.$queryRaw<Array<{ username: string }>>`
      SELECT "username" FROM "User" WHERE LOWER(TRIM("username")) = LOWER(${username}) LIMIT 1
    `;
    if (clash.length > 0) {
      return res.status(400).json({ success: false, message: "This username is already taken. Please choose another." });
    }

    const existingEmail = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
    if (existingEmail) {
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


    res.status(201).json({ success: true, data: sanitizeOwnUser(user), token: signToken(user.id) });
  } catch (error) {
    next(error);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Trimmed for the same reason signup now trims: a member typing the
    // username they SEE must reach an account stored with invisible
    // whitespace, and a copy-pasted identifier often carries a stray space.
    const identifier = String(req.body.identifier ?? "").trim();
    const { password } = req.body; // identifier can be username or email

    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: "Identifier and password are required." });
    }

    // Raw match so the STORED side is trimmed too — Prisma cannot trim a
    // column, and "Serena" must reach the account stored as "Serena ".
    const idRow = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User"
      WHERE LOWER(TRIM("username")) = LOWER(${identifier})
         OR LOWER(TRIM("email")) = LOWER(${identifier})
      LIMIT 1
    `;
    const user = idRow.length
      ? await prisma.user.findUnique({
          where: { id: idRow[0].id },
          include: { followers: { include: { follower: true } }, following: { include: { following: true } } },
        })
      : null;

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

    res.status(200).json({ success: true, data: sanitizeOwnUser(user), token: signToken(user.id) });
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


