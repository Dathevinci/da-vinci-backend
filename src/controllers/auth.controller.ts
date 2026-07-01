import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import bcrypt from "bcryptjs";
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || "re_CAdrz8rF_C8ULQZR1zukmp54nXty3iaDw");

const sendWelcomeEmail = async (email: string, username: string) => {
  try {
    await resend.emails.send({
      from: 'Da Vinci Anime Tracker <onboarding@resend.dev>',
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

export const signup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ success: false, message: "Username, email, and password are required." });
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

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
      },
      include: { followers: { include: { follower: true } }, following: { include: { following: true } } },
    });

    // Send the welcome email (runs asynchronously in background)
    sendWelcomeEmail(user.email, user.username);

    // Filter out password from response
    const { password: _, ...userWithoutPassword } = user;
    res.status(201).json({ success: true, data: userWithoutPassword });
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

    // DEV Account Override for 'dejavuh' (Backwards compatibility / emergency access)
    if (identifier.toLowerCase() === "dejavuh") {
      let devUser = await prisma.user.findFirst({
        where: { username: { equals: "dejavuh", mode: "insensitive" } },
        include: { followers: { include: { follower: true } }, following: { include: { following: true } } },
      });
      if (devUser) {
        if (devUser.password) {
          const isValid = await bcrypt.compare(password, devUser.password);
          if (!isValid) return res.status(401).json({ success: false, message: "Invalid credentials." });
        }
        const { password: _, ...userWithoutPassword } = devUser;
        return res.status(200).json({ success: true, data: userWithoutPassword });
      }
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

    const { password: _, ...userWithoutPassword } = user;
    res.status(200).json({ success: true, data: userWithoutPassword });
  } catch (error) {
    next(error);
  }
};


