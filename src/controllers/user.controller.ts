import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { payout, getRole } from "../utils/economy";
import { sanitizeOwnUser, sanitizePublicUser, sanitizePublicUsers } from "../utils/sanitizeUser";
import { signToken, getActorId } from "../lib/jwt";


export const createUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const username = req.body.username?.trim();
    const email = req.body.email?.trim();
    const inviteCode = req.body.inviteCode?.trim();

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
      return res.status(200).json({ success: true, data: sanitizeOwnUser(user), token: signToken(user.id) });
    }

    // Register new user (requires invite code)
    if (!inviteCode) {
      return res.status(403).json({ success: false, requires_invite: true, message: "An invite code is required to join." });
    }

    const invite = await prisma.inviteCode.findUnique({
      where: { code: inviteCode.toUpperCase() },
    });

    if (!invite) {
      return res.status(400).json({ success: false, message: "Invalid invite code." });
    }
    if (invite.isUsed) {
      return res.status(400).json({ success: false, message: "This invite code has already been used." });
    }

    user = await prisma.user.create({
      data: { username, email, avatar: req.body.avatar },
      include: { followers: { include: { follower: true } }, following: { include: { following: true } } }
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
        manhwaBookmarks: true,
        novelBookmarks: true,
        likes: true,
        followers: { include: { follower: true } },
        following: { include: { following: true } }
      },
    });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, data: sanitizePublicUser(user) });
  } catch (error) {
    next(error);
  }
};

// Arise Points charged for every username change after the first (free) one.
export const USERNAME_CHANGE_COST = 500;

// Change a username. The first change is free; every change after that costs
// Arise Points. Staff (Lead Dev / Admins) always change for free.
export const changeUsername = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.id as string;

    // Only the owner may rename this account (verified token wins; tokenless
    // pre-JWT sessions are grandfathered).
    const actor = getActorId(req);
    if (actor && actor !== userId) {
      return res.status(403).json({ success: false, message: "You can only change your own username." });
    }

    const raw = (req.body.username || "").trim();

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(raw)) {
      return res.status(400).json({
        success: false,
        message: "Username must be 3–20 characters — letters, numbers, or underscores only.",
      });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    if (raw.toLowerCase() === user.username.toLowerCase()) {
      return res.status(400).json({ success: false, message: "That's already your username." });
    }

    // Case-insensitive uniqueness so "Coffee" can't collide with "coffee".
    const taken = await prisma.user.findFirst({
      where: { username: { equals: raw, mode: "insensitive" }, id: { not: userId } },
    });
    if (taken) return res.status(409).json({ success: false, message: "That username is already taken." });

    // Role is tied to the account and must survive renames. Prefer the stored
    // role; self-heal from the current username for accounts not yet backfilled.
    const role = ((user as any).role && (user as any).role !== "USER" ? (user as any).role : getRole(user.username)) as string;
    const isStaff = role === "LEAD_DEV" || role === "ADMIN";
    const isFree = isStaff || user.usernameChanges === 0;
    const cost = isFree ? 0 : USERNAME_CHANGE_COST;

    if (cost > 0 && user.arisePoints < cost) {
      return res.status(402).json({
        success: false,
        message: `You need ${cost} Arise Points to change your username again — you have ${user.arisePoints}.`,
        cost,
        arisePoints: user.arisePoints,
      });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        username: raw,
        usernameChanges: { increment: 1 },
        role, // lock the role onto the account so this and future renames keep it
        ...(cost > 0 && { arisePoints: { decrement: cost } }),
      },
    });

    if (cost > 0) {
      await prisma.pointLog.create({
        data: { userId, amount: -cost, reason: `Username change to ${raw}` },
      });
    }

    res.json({ success: true, data: sanitizeOwnUser(updated), cost, wasFree: isFree });
  } catch (error) {
    next(error);
  }
};

export const updateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // isAdmin/role/xp are deliberately NOT destructured: they must never be
    // settable through the public profile PATCH (that was a self-escalation to
    // admin). They change only via trusted server-side paths.
    const { username, email, avatar, bannerUrl, bannerPosition, bannerStyle, bio, arisePoints, isPrivate, theme,
            purchasedBanners, purchasedTags, purchasedRoles, purchasedEffects, purchasedThemes, purchasedColors, purchasedFonts, purchasedFrames,
            activeRole, activeTag, activeEffect, activeTheme, activeColor, activeFont, activeFrame } = req.body;
    const userId = req.params.id as string;

    // Identity guard (soft): if the request carries a VERIFIED token, it must be
    // the owner. Tokenless pre-JWT sessions are grandfathered so nobody is locked
    // out mid-session — they get a token on their next login and become protected.
    const actor = getActorId(req);
    if (actor && actor !== userId) {
      return res.status(403).json({ success: false, message: "You can only edit your own profile." });
    }

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

    // Cosmetic-equip ownership gate: you can only DISPLAY what you own.
    // Purchases/gifts are already server-authoritative, but equipping was not —
    // anyone could PATCH activeEffect:"effect_dejavu" and wear a limited SSS
    // effect they never bought, gutting its exclusivity. Rules: unequips (null)
    // and the "effect_none" sentinel always pass; re-saving the value already
    // stored passes (legacy grandfather — nobody's current look is stripped);
    // staff pass; otherwise an equip of an unowned effect/frame is silently
    // dropped so the rest of the profile save still applies.
    let allowedActiveEffect = activeEffect;
    let allowedActiveFrame = activeFrame;
    const wantsEffect = typeof activeEffect === "string" && activeEffect && activeEffect !== "effect_none";
    const wantsFrame = typeof activeFrame === "string" && activeFrame;
    if (wantsEffect || wantsFrame) {
      const current = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true, role: true, activeEffect: true, activeFrame: true, purchasedEffects: true, purchasedFrames: true },
      });
      if (current) {
        const role = current.role && current.role !== "USER" ? current.role : getRole(current.username);
        const staff = role === "LEAD_DEV" || role === "ADMIN";
        if (!staff) {
          if (wantsEffect && activeEffect !== current.activeEffect && !current.purchasedEffects.includes(activeEffect)) {
            allowedActiveEffect = undefined;
          }
          if (wantsFrame && activeFrame !== current.activeFrame && !current.purchasedFrames.includes(activeFrame)) {
            allowedActiveFrame = undefined;
          }
        }
      }
    }

    const updateData: any = {
      // NOTE: username goes through the gated changeUsername endpoint.
      // arisePoints + purchased* are DELIBERATELY not client-writable — money and
      // inventory change ONLY via server-authoritative paths (the /purchase and
      // /gift endpoints, the Ko-fi webhook, and the avatar/banner reward below).
      // This is what stops the browser minting points or granting itself items.
      ...(email && { email }),
      ...(avatar !== undefined && { avatar }),
      ...(bannerUrl !== undefined && { bannerUrl }),
      ...(bannerPosition !== undefined && { bannerPosition: Math.max(0, Math.min(100, Number(bannerPosition))) }),
      ...(bannerStyle !== undefined && { bannerStyle: bannerStyle === "cover" ? "cover" : "full" }),
      ...(bio !== undefined && { bio }),
      ...(isPrivate !== undefined && { isPrivate: Boolean(isPrivate) }),
      ...(theme !== undefined && { theme }),
      ...(activeRole !== undefined && { activeRole }),
      ...(activeTag !== undefined && { activeTag }),
      ...(allowedActiveEffect !== undefined && { activeEffect: allowedActiveEffect }),
      ...(activeTheme !== undefined && { activeTheme }),
      ...(activeColor !== undefined && { activeColor }),
      ...(activeFont !== undefined && { activeFont }),
      ...(allowedActiveFrame !== undefined && { activeFrame: allowedActiveFrame }),
    };

    if (incrementPoints > 0 && arisePoints === undefined) {
      updateData.arisePoints = { increment: incrementPoints };
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    res.json({ success: true, data: sanitizeOwnUser(user) });
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

    // Deletion is destructive + irreversible → HARD-require a verified token
    // (the owner, or an admin). No frontend exposes this, so no legitimate user
    // is affected; it closes the "anyone can delete any account" hole.
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to delete your account." });
    }
    if (actor !== userId) {
      const actingUser = await prisma.user.findUnique({ where: { id: actor } });
      const role = (actingUser as any)?.role;
      if (role !== "ADMIN" && role !== "LEAD_DEV") {
        return res.status(403).json({ success: false, message: "You can only delete your own account." });
      }
    }

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
        manhwaBookmarks: true,
        novelBookmarks: true,
        likes: true,
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
        user.manhwaBookmarks = [];
        user.novelBookmarks = [];
        user.likes = [];
        user.bio = "This profile is private. You must mutually follow each other to see their bio, banner, and watchlist.";
        user.bannerUrl = null;
      }
    }

    res.json({ success: true, data: sanitizePublicUser(user) });
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
    res.json({ success: true, data: sanitizePublicUsers(users) });
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

    // Award the follower for following an account — once per unique target, so
    // unfollowing (no refund) and re-following again earns nothing. Dedup is
    // keyed on a per-target PointLog reason.
    const followingUser = await prisma.user.findUnique({ where: { id: followingId } });
    const isLeadDev = followingUser?.username.toLowerCase() === "dejavuh";
    const followReason = `follow:${followingId}`;
    const alreadyAwarded = await prisma.pointLog.findFirst({ where: { userId: followerId, reason: followReason } });

    if (!alreadyAwarded) {
      const { ap, xp } = payout("follow");
      await prisma.user.update({
        where: { id: followerId },
        data: { arisePoints: { increment: ap }, xp: { increment: xp } }
      });
      await prisma.pointLog.create({
        data: { userId: followerId, amount: ap, reason: followReason }
      });
      await prisma.notification.create({
        data: {
          userId: followerId,
          actorId: followingId,
          type: "ARISE_POINTS_EARNED",
          message: isLeadDev
            ? `You earned ${ap} Arise Points for following the Lead Developer!`
            : `You earned ${ap} Arise Points for following ${followingUser?.username || "a user"}!`,
          link: followingUser?.username ? `/user/${followingUser.username}` : undefined,
        }
      });
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

export const addXpForWatching = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.id as string;
    const { animeId, episode } = (req.body || {}) as { animeId?: number | string; episode?: number | string };

    // Dedup: reward only the FIRST time a given episode is watched, so rewatching
    // can't farm XP and a long series rewards proportionally to episodes watched.
    const dedupKey =
      animeId != null && episode != null ? `watch:${animeId}:${episode}` : null;

    if (dedupKey) {
      const already = await prisma.pointLog.findFirst({ where: { userId, reason: dedupKey } });
      if (already) {
        const current = await prisma.user.findUnique({ where: { id: userId } });
        return res.json({
          success: true,
          awarded: false,
          data: { arisePoints: current?.arisePoints ?? 0, xp: current?.xp ?? 0 },
        });
      }
    }

    const { ap, xp } = payout("watch");

    const user = await prisma.user.update({
      where: { id: userId },
      data: { arisePoints: { increment: ap }, xp: { increment: xp } }
    });

    await prisma.pointLog.create({
      data: { userId, amount: ap, reason: dedupKey || "Watched an episode" }
    });

    res.json({ success: true, awarded: true, data: { arisePoints: user.arisePoints, xp: user.xp } });
  } catch (error) {
    next(error);
  }
};

// Award Arise Points + XP for a repeatable content action — reading a manhwa /
// novel chapter, or adding a title to your library. This is the manhwa/novel
// analogue of addXpForWatching. Server-authoritative + idempotent: the payout is
// fixed by a WHITELISTED `action` (so the client can't pick the amount) and
// deduped on a per-key PointLog reason (so the same chapter/title never pays
// twice).
//
// POST /api/users/:id/earn   body: { action: "read" | "track", key: string }
//   read  → key "manhwa:<mangaId>:<chapterId>" | "novel:<novelId>:<chapterId>"
//   track → key "manhwa:<mangaId>"             | "novel:<novelId>"
const EARN_ACTIONS = ["read", "track"] as const;

export const earnPoints = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.id as string;
    const { action, key } = (req.body || {}) as { action?: string; key?: string };

    // Only the owner may earn for this account (verified token wins; tokenless
    // pre-JWT sessions grandfathered).
    const actor = getActorId(req);
    if (actor && actor !== userId) {
      return res.status(403).json({ success: false, message: "You can only earn for your own account." });
    }

    if (!action || !key || !EARN_ACTIONS.includes(action as any) || key.length > 300) {
      return res.status(400).json({ success: false, message: "Invalid earn action." });
    }

    const reason = `${action}:${key}`;

    // Dedup — award only the FIRST time for this exact key.
    const already = await prisma.pointLog.findFirst({ where: { userId, reason } });
    if (already) {
      const current = await prisma.user.findUnique({ where: { id: userId }, select: { arisePoints: true, xp: true } });
      return res.json({ success: true, awarded: false, data: { arisePoints: current?.arisePoints ?? 0, xp: current?.xp ?? 0 } });
    }

    const { ap, xp } = payout(action as any);
    const user = await prisma.user.update({
      where: { id: userId },
      data: { arisePoints: { increment: ap }, xp: { increment: xp } },
    });
    await prisma.pointLog.create({ data: { userId, amount: ap, reason } });

    res.json({ success: true, awarded: true, data: { arisePoints: user.arisePoints, xp: user.xp } });
  } catch (error) {
    next(error);
  }
};
