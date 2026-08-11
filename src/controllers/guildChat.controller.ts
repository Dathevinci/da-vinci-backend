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
 *
 * REPLIES follow the same rule: replyToId is a plain string with no FK, so
 * deleting a parent leaves its replies standing and `replyTo` simply resolves
 * to null. The client renders "message deleted" rather than losing the thread.
 *
 * EDITING is AUTHOR-ONLY — not the leader, not the co-leader, not a chat
 * moderator. Removing someone's words (delete) and PUTTING WORDS IN THEIR
 * MOUTH (edit) are different powers, and only the second one is forgery.
 * Nobody gets it.
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

// ── ONE wire shape for a message ────────────────────────────────────────────
// list, post and edit all answer with the SAME object, built here, because an
// edit that came back shaped differently from the list would force the client
// to write a second reader for the same row.

/** Only the columns the shaper reads — every caller selects at least these. */
type MessageRow = {
  id: string;
  userId: string;
  content: string | null;
  mediaUrl: string | null;
  createdAt: Date;
  editedAt: Date | null;
  replyToId: string | null;
};

/** The quoted parent, flattened. `username` is null when the parent's author
 *  is a deleted account — the same hole `author: null` leaves. */
type ReplyPreview = {
  id: string;
  userId: string;
  username: string | null;
  content: string | null;
  mediaUrl: string | null;
};

/** The parent columns a preview needs, and nothing else. */
const PARENT_SELECT = { id: true, userId: true, content: true, mediaUrl: true } as const;

function shapeMessage<A>(m: MessageRow, author: A | null | undefined, replyTo: ReplyPreview | null) {
  return {
    id: m.id,
    userId: m.userId,
    content: m.content,
    mediaUrl: m.mediaUrl,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    replyToId: m.replyToId,
    author: author ?? null,
    // null when the parent was deleted (or never existed) — the client shows
    // "message deleted" and the reply itself is untouched.
    replyTo,
  };
}

/** Single-message reply preview, for the post/edit responses. The list path
 *  does NOT use this — it batches (see listMessages) — but one row answering
 *  one request is one lookup either way. */
async function replyPreviewOf(
  parent: { id: string; userId: string; content: string | null; mediaUrl: string | null } | null
): Promise<ReplyPreview | null> {
  if (!parent) return null;
  const author = await prisma.user.findUnique({
    where: { id: parent.userId },
    select: { username: true },
  });
  return {
    id: parent.id,
    userId: parent.userId,
    username: author?.username ?? null,
    content: parent.content,
    mediaUrl: parent.mediaUrl,
  };
}

/** The parent a reply may point at, or null. Scoped to THIS guild: a reply
 *  must never quote across guilds, so a real id under another guild is a 404,
 *  exactly like an id that does not exist. */
async function findParentInGuild(guildId: string, replyToId: string) {
  return prisma.guildMessage.findFirst({
    where: { id: replyToId, guildId },
    select: PARENT_SELECT,
  });
}

/** Shared by postMessage and editMessage so the two can never drift: trim,
 *  1..CONTENT_MAX. The caller decides whether EMPTY is allowed — a post may
 *  be media-only, an edit may not (see editMessage). */
function checkContent(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    return { ok: false, message: "Invalid message." };
  }
  const content = typeof raw === "string" ? raw.trim() : "";
  if (content.length > CONTENT_MAX) {
    return { ok: false, message: `Messages are capped at ${CONTENT_MAX} characters.` };
  }
  return { ok: true, value: content };
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

    // ONE batched lookup for the quoted parents of this page — never one per
    // message. Scoped to this guild for the same reason the write path is.
    // Parents that were deleted simply don't come back and resolve to null.
    const parentIds = Array.from(
      new Set(messages.map((m) => m.replyToId).filter((id): id is string => !!id))
    );
    const parents = parentIds.length
      ? await prisma.guildMessage.findMany({
          where: { id: { in: parentIds }, guildId },
          select: PARENT_SELECT,
        })
      : [];
    const parentById = new Map(parents.map((p) => [p.id, p]));

    // ONE batched author lookup per request, however many messages came back.
    // The parents' authors ride along in the SAME query rather than costing a
    // second one — a reply to someone who hasn't spoken again on this page
    // still needs their username for the quote line.
    const authorIds = Array.from(
      new Set([...messages.map((m) => m.userId), ...parents.map((p) => p.userId)])
    );
    const users = authorIds.length
      ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: AUTHOR_SELECT })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    res.json({
      success: true,
      data: messages.map((m) => {
        const parent = m.replyToId ? parentById.get(m.replyToId) ?? null : null;
        const replyTo: ReplyPreview | null = parent
          ? {
              id: parent.id,
              userId: parent.userId,
              username: byId.get(parent.userId)?.username ?? null,
              content: parent.content,
              mediaUrl: parent.mediaUrl,
            }
          : null;
        return shapeMessage(m, byId.get(m.userId), replyTo);
      }),
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

    const rawMedia = req.body?.mediaUrl;
    const rawReplyTo = req.body?.replyToId;
    const checked = checkContent(req.body?.content);
    if (!checked.ok) {
      return res.status(400).json({ success: false, message: checked.message });
    }
    if (rawMedia !== undefined && rawMedia !== null && typeof rawMedia !== "string") {
      return res.status(400).json({ success: false, message: "Invalid media link." });
    }
    if (rawReplyTo !== undefined && rawReplyTo !== null && typeof rawReplyTo !== "string") {
      return res.status(400).json({ success: false, message: "Invalid reply target." });
    }
    const content = checked.value;
    const mediaUrl = typeof rawMedia === "string" ? rawMedia.trim() : "";
    const replyToId = typeof rawReplyTo === "string" ? rawReplyTo.trim() : "";

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

    // The parent must EXIST and live in THIS guild. Checked before the write,
    // so a reply is never stored pointing at nothing or across a guild wall.
    // (A parent deleted a millisecond later is fine — the row survives with a
    // dangling id and reads as "message deleted", which is the whole reason
    // replyToId carries no FK.)
    const parent = replyToId ? await findParentInGuild(guildId, replyToId) : null;
    if (replyToId && !parent) {
      return res.status(404).json({ success: false, message: "That message is no longer here." });
    }

    const message = await prisma.guildMessage.create({
      data: {
        guildId,
        userId: actor.id,
        content: content || null,
        mediaUrl: mediaUrl || null,
        replyToId: parent ? parent.id : null,
      },
    });
    const author = await prisma.user.findUnique({ where: { id: actor.id }, select: AUTHOR_SELECT });
    const replyTo = await replyPreviewOf(parent);

    res.status(201).json({ success: true, data: shapeMessage(message, author, replyTo) });
  } catch (error) {
    next(error);
  }
};

// ── PATCH /api/guilds/:id/messages/:messageId ───────────────────────────────
// AUTHOR ONLY. Deliberately NARROWER than delete: the leader, the co-leader
// and moderateChat holders can all remove a message, and NONE of them can
// change one. Deleting says "this doesn't belong here"; editing says "you
// said this" over someone else's name, and no role on this site grants that.
//
// Three walls, in order: a verified actor, current membership of THIS guild
// (re-checked per request like every other chat handler — being kicked closes
// the room, including for edits), and message.userId === actor. The message
// must also belong to guild :id, so a real id under another guild is a 404
// rather than a route into a room the actor isn't in.
//
// Only `content` moves. mediaUrl is not editable — swapping the image under
// a message people have already read is the same forgery this handler exists
// to prevent — and neither is replyToId: an edit can't re-point a reply at a
// different parent after the fact.

export const editMessage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to edit." });
    }
    const guildId = req.params.id as string;
    const messageId = req.params.messageId as string;

    const member = await membershipIn(guildId, actor.id);
    if (!member) {
      return res.status(403).json({ success: false, message: "Guild chat is members-only." });
    }

    const existing = await prisma.guildMessage.findUnique({ where: { id: messageId } });
    if (!existing || existing.guildId !== guildId) {
      return res.status(404).json({ success: false, message: "Message not found." });
    }
    if (existing.userId !== actor.id) {
      return res.status(403).json({ success: false, message: "You can only edit your own messages." });
    }

    const checked = checkContent(req.body?.content);
    if (!checked.ok) {
      return res.status(400).json({ success: false, message: checked.message });
    }
    // A post may be media-only ("a GIF on its own is a message"), but an EDIT
    // to nothing is not a message — it's a delete wearing an edit's clothes,
    // and DELETE is right there.
    if (!checked.value) {
      return res.status(400).json({ success: false, message: "Write something, or delete the message instead." });
    }

    const message = await prisma.guildMessage.update({
      where: { id: messageId },
      data: { content: checked.value, editedAt: new Date() },
    });

    // Same shape the list returns, quoted parent included — the client swaps
    // the row in place and must not have to re-fetch to keep the reply line.
    const author = await prisma.user.findUnique({ where: { id: actor.id }, select: AUTHOR_SELECT });
    const parent = message.replyToId ? await findParentInGuild(guildId, message.replyToId) : null;
    const replyTo = await replyPreviewOf(parent);

    res.json({ success: true, data: shapeMessage(message, author, replyTo) });
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
