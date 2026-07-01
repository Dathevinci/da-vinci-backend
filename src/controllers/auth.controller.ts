import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import axios from "axios";

// Nodemailer config for welcome emails
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER || "siddharthashahthakuri447@gmail.com",
    pass: process.env.GMAIL_APP_PASSWORD || "", // Must be provided in .env
  },
});

const sendWelcomeEmail = async (email: string, username: string) => {
  try {
    if (!process.env.GMAIL_APP_PASSWORD) {
      console.warn("GMAIL_APP_PASSWORD missing. Skipping welcome email.");
      return;
    }
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

// DISCORD OAUTH CONFIG
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI = process.env.NEXT_PUBLIC_API_URL 
  ? \`\${process.env.NEXT_PUBLIC_API_URL}/api/auth/discord/callback\` 
  : "http://localhost:5000/api/auth/discord/callback";

export const discordLogin = (req: Request, res: Response) => {
  const url = \`https://discord.com/api/oauth2/authorize?client_id=\${DISCORD_CLIENT_ID}&redirect_uri=\${encodeURIComponent(DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20email\`;
  res.redirect(url);
};

export const discordCallback = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("No code provided.");

    // Exchange code for token
    const tokenResponse = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: code as string,
        redirect_uri: DISCORD_REDIRECT_URI,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { access_token } = tokenResponse.data;

    // Get user info
    const userResponse = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: \`Bearer \${access_token}\` },
    });

    const discordUser = userResponse.data;

    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { discordId: discordUser.id },
          { email: discordUser.email },
        ],
      },
      include: { followers: { include: { follower: true } }, following: { include: { following: true } } },
    });

    if (user) {
      // Update discordId if they had an email account but are now linking discord
      if (!user.discordId) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { discordId: discordUser.id, avatar: \`https://cdn.discordapp.com/avatars/\${discordUser.id}/\${discordUser.avatar}.png\` },
          include: { followers: { include: { follower: true } }, following: { include: { following: true } } },
        });
      }
    } else {
      // Create new user
      // Ensure unique username
      let baseUsername = discordUser.username;
      let uniqueUsername = baseUsername;
      let counter = 1;
      while (await prisma.user.findUnique({ where: { username: uniqueUsername } })) {
        uniqueUsername = \`\${baseUsername}\${counter}\`;
        counter++;
      }

      user = await prisma.user.create({
        data: {
          username: uniqueUsername,
          email: discordUser.email,
          discordId: discordUser.id,
          avatar: \`https://cdn.discordapp.com/avatars/\${discordUser.id}/\${discordUser.avatar}.png\`,
        },
        include: { followers: { include: { follower: true } }, following: { include: { following: true } } },
      });

      sendWelcomeEmail(user.email, user.username);
    }

    const { password: _, ...userWithoutPassword } = user;
    
    // Encode user state to pass securely back to frontend
    const encodedUser = Buffer.from(JSON.stringify(userWithoutPassword)).toString("base64");
    
    const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(\`\${FRONTEND_URL}/auth/callback?data=\${encodedUser}\`);
  } catch (error) {
    console.error("Discord OAuth Error:", error);
    res.redirect(\`\${process.env.FRONTEND_URL || "http://localhost:3000"}?error=DiscordLoginFailed\`);
  }
};
