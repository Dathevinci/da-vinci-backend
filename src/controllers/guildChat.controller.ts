import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { resolveActor } from "../lib/staff";

/**
 * GUILD CHAT — a Discord-style message stream per guild. Members-only BOTH
 * ways: the old board was public-read, chat is not, so even GET demands a
 * verified actor who is currently IN this guild. Membership is re-checked on
 * every request rather than cached — leaving or being kicked closes the room
 * immediately, the standing-fact rule the loan cleanup already follows.
 *
 * Chat mints NOTHING — no Arise Points, no XP. Any payout here would turn a
 * message loop into a printing press, so there is deliberately no earn hook.
 *
 * Messages keep a plain-string userId (the duel pattern). A deleted account's
 * messages survive with `author: null` — the reader shapes around the hole.
 */

const LIST_DEFAULT = 60;
const LIST_MAX = 100;
const CONTENT_MAX = 500;
// Permissive on purpose, matching the comment system's mediaUrl stance: the
// GIF CDN hosts vary too much for an allow-list, so the wall is https + length.
const MEDIA_MAX = 600;
const FLOOD_MS = 1500; // min gap between one user's messages in one guild

// The living-username bundle — everywhere a username renders, the SSS effect
// treatment rides along, so the author lookup carries the styling columns.
const AUTHOR_SELECT = {
  id: true, username: true, avatar: true, role: true,
  activeEffect: true, activeColor: true, activeFont: true,
} as const;

/** Null unless the actor is currently a member of THIS guild. One lookup —
 *  GuildMember.userId is unique, so it answers "in a guild" and "this one". */
async function membershipIn(guildId: string, actorId: string) {
  const member = await prisma.guildMember.findUnique({ where: { userId: actorId } });
  return member && member.guildId === guildId ? member : null;
}

// ── GET /api/guilds/:id/messages ────────────────────────────────────────────
// ?after=<messageId> is the poll cursor: only rows strictly newer than that
// message come back (ascending). An unknown/foreign id degrades to "no
// cursor" rather than erroring — a message deleted between polls must not
// wedge the client. Equal-createdAt ties across the cursor boundary are the
// accepted once-per-ms edge; the secondary id ordering keeps the stream
// stable, not gapless.

export const listMessages = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to read guild chat." });
    }
    const guildId = req.params.id as string;
    const member = await membershipIn(guildId, actor.id);
    if (!member) {
      return res.status(403).json({ success: false, message: "Guild chat is members-only." });
    }

    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.floor(rawLimit), 1), LIST_MAX)
      : LIST_DEFAULT;

    const after = typeof req.query.after === "string" && req.query.after ? req.query.after : null;
    // Scoped to THIS guild — a message id from another guild is not a valid
    // window into this one, so it degrades to no cursor like an unknown id.
    const cursor = after
      ? await prisma.guildMessage.findFirst({
          where: { id: after, guildId },
          select: { createdAt: true },
        })
      : null;

    const messages = cursor
      ? await prisma.guildMessage.findMany({
          where: { guildId, createdAt: { gt: cursor.createdAt } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit,
        })
      : (
          await prisma.guildMessage.findMany({
            where: { guildId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit,
          })
        ).reverse(); // newest N, but delivered oldest-first like a chat log reads

    // ONE batched author lookup per request, however many messages came back.
    const authorIds = Array.from(new Set(messages.map((m) => m.userId)));
    const users = authorIds.length
      ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: AUTHOR_SELECT })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    res.json({
      success: true,
      data: messages.map((m) => ({
        id: m.id, userId: m.userId, content: m.content, mediaUrl: m.mediaUrl,
        createdAt: m.createdAt, author: byId.get(m.userId) ?? null,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/guilds/:id/messages/head ───────────────────────────────────────
// The dock's unread probe, polled from every page. listMessages?limit=1 would
// answer the same question but ships a whole message row plus a batched author
// lookup; this is ONE row, two columns, no join. The gate is IDENTICAL to
// listMessages — cheap is not the same as public, and the room is private —
// so it costs the same membership check, which is the point of keeping the
// payload this small. Ordering matches listMessages' newest-first path,
// tiebreak included, or a same-millisecond pair could name a different
// "newest" than the stream renders. An empty room answers null/null rather
// than 404: "nothing yet" is a state, not an error.

export const messagesHead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to read guild chat." });
    }
    const guildId = req.params.id as string;
    const member = await membershipIn(guildId, actor.id);
    if (!member) {
      return res.status(403).json({ success: false, message: "Guild chat is members-only." });
    }

    const newest = await prisma.guildMessage.findFirst({
      where: { guildId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, createdAt: true },
    });

    res.json({
      success: true,
      data: {
        id: newest?.id ?? null,
        // Explicit ISO, not the Date JSON would emit for us: the client
        // compares this string across polls, so the shape must not depend on
        // serializer behaviour.
        createdAt: newest ? newest.createdAt.toISOString() : null,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/:id/messages ───────────────────────────────────────────

export const postMessage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to chat." });
    }
    const guildId = req.params.id as string;
    const member = await membershipIn(guildId, actor.id);
    if (!member) {
      return res.status(403).json({ success: false, message: "Guild chat is members-only." });
    }

    const rawContent = req.body?.content;
    const rawMedia = req.body?.mediaUrl;
    if (rawContent !== undefined && rawContent !== null && typeof rawContent !== "string") {
      return res.status(400).json({ success: false, message: "Invalid message." });
    }
    if (rawMedia !== undefined && rawMedia !== null && typeof rawMedia !== "string") {
      return res.status(400).json({ success: false, message: "Invalid media link." });
    }
    const content = typeof rawContent === "string" ? rawContent.trim() : "";
    const mediaUrl = typeof rawMedia === "string" ? rawMedia.trim() : "";

    if (content.length > CONTENT_MAX) {
      return res.status(400).json({ success: false, message: `Messages are capped at ${CONTENT_MAX} characters.` });
    }
    if (mediaUrl) {
      if (mediaUrl.length > MEDIA_MAX) {
        return res.status(400).json({ success: false, message: "That media link is too long." });
      }
      if (!mediaUrl.startsWith("https://")) {
        return res.status(400).json({ success: false, message: "Media links must start with https://." });
      }
    }
    // A GIF on its own is a message — the comment system learned this the
    // hard way. But empty-on-both is not.
    if (!content && !mediaUrl) {
      return res.status(400).json({ success: false, message: "Write something or attach an image." });
    }

    // Flood guard: per user, per guild, keyed off their newest message. A
    // best-effort brake, not a ledger — two racing requests may both pass,
    // which costs one extra chat line, nothing of value.
    const last = await prisma.guildMessage.findFirst({
      where: { guildId, userId: actor.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (last && Date.now() - last.createdAt.getTime() < FLOOD_MS) {
      return res.status(429).json({ success: false, message: "Slow down a touch." });
    }

    const message = await prisma.guildMessage.create({
      data: {
        guildId,
        userId: actor.id,
        content: content || null,
        mediaUrl: mediaUrl || null,
      },
    });
    const author = await prisma.user.findUnique({ where: { id: actor.id }, select: AUTHOR_SELECT });

    res.status(201).json({
      success: true,
      data: {
        id: message.id, userId: message.userId, content: message.content,
        mediaUrl: message.mediaUrl, createdAt: message.createdAt, author: author ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/guilds/:id/messages/:messageId ──────────────────────────────
// The author, the leader, the co-leader, or a member whose CUSTOM ROLE grants
// moderateChat. The message must belong to guild :id — a valid message id
// under the wrong guild is a 404, not a loophole for officers of one guild to
// moderate another — and the custom-role path re-anchors membership AND role
// to this same guildId, so moderateChat never reaches outside the holder's
// own guild. Plain delete; chat mints nothing, so there is nothing to claw
// back.

export const deleteMessage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const guildId = req.params.id as string;
    const messageId = req.params.messageId as string;

    const message = await prisma.guildMessage.findUnique({ where: { id: messageId } });
    if (!message || message.guildId !== guildId) {
      return res.status(404).json({ success: false, message: "Message not found." });
    }
    const guild = await prisma.guild.findUnique({ where: { id: guildId } });
    if (!guild) {
      return res.status(404).json({ success: false, message: "Guild not found." });
    }

    let allowed =
      message.userId === actor.id || guild.leaderId === actor.id || guild.coLeaderId === actor.id;
    if (!allowed) {
      // Custom-role path, resolved fresh (the standing-fact rule): the actor's
      // membership in THIS guild, then their role in THIS guild. Permissions
      // are normalized at write time, so a strict `=== true` read suffices.
      const member = await membershipIn(guildId, actor.id);
      const role = member?.customRoleId
        ? await prisma.guildRole.findFirst({ where: { id: member.customRoleId, guildId } })
        : null;
      const perms = role?.permissions;
      allowed =
        !!perms && typeof perms === "object" && !Array.isArray(perms) &&
        (perms as Record<string, unknown>).moderateChat === true;
    }
    if (!allowed) {
      return res.status(403).json({ success: false, message: "Only the author, the leader, the co-leader or a chat moderator can delete a message." });
    }

    await prisma.guildMessage.delete({ where: { id: messageId } });
    res.json({ success: true, data: { deleted: messageId } });
  } catch (error) {
    next(error);
  }
};
