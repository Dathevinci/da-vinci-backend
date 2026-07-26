import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { requireStaff } from "../lib/staff";
import { writeAudit, actorIp } from "../lib/audit";
import { parsePage, confirmMatches } from "../lib/consoleGuards";

/**
 * Lead Dev console — site operations, moderation, insights, audit.
 *
 * Same rule as console.controller.ts: EVERY handler, reads included, opens with
 * requireStaff(req, res, { leadDevOnly: true }). An ADMIN token gets 403.
 */

const TEN_YEARS = 1000 * 60 * 60 * 24 * 365 * 10;

/** GET /api/console/ops/status */
export const opsStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    // Doubles as a DB latency probe.
    const t0 = Date.now();
    const users = await prisma.user.count();
    const dbMs = Date.now() - t0;

    const maintenanceCache = await prisma.cacheItem.findUnique({ where: { key: "MAINTENANCE_MODE" } });

    res.json({
      success: true,
      data: {
        maintenance: maintenanceCache?.data === "true",
        dbMs,
        users,
        uptimeSec: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        node: process.version,
        env: process.env.NODE_ENV || "development",
        // Booleans ONLY. Never a value, prefix, or length — this endpoint exists
        // to answer "is it configured", not "what is it".
        secrets: {
          JWT_SECRET: !!process.env.JWT_SECRET,
          DATABASE_URL: !!process.env.DATABASE_URL,
          KOFI_VERIFICATION_TOKEN: !!process.env.KOFI_VERIFICATION_TOKEN,
          DISCORD_CLIENT_ID: !!process.env.DISCORD_CLIENT_ID,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/** POST /api/console/ops/maintenance  body: { enabled, confirm?, note? } */
export const setMaintenance = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const { enabled, confirm, note } = req.body as { enabled?: boolean; confirm?: string; note?: string };
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ success: false, message: "enabled must be true or false." });
    }
    // Turning the site OFF needs friction; turning it back ON never should.
    if (enabled && !confirmMatches(confirm, "MAINTENANCE")) {
      return res.status(400).json({ success: false, message: 'Type MAINTENANCE to confirm taking the site down.' });
    }

    await prisma.cacheItem.upsert({
      where: { key: "MAINTENANCE_MODE" },
      update: { data: enabled ? "true" : "false", expiresAt: new Date(Date.now() + TEN_YEARS) },
      create: { key: "MAINTENANCE_MODE", data: enabled ? "true" : "false", expiresAt: new Date(Date.now() + TEN_YEARS) },
    });

    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "ops.maintenance",
      targetType: "system",
      targetLabel: "MAINTENANCE_MODE",
      after: { enabled },
      note,
      ip: actorIp(req),
    });

    res.json({ success: true, data: { maintenance: enabled } });
  } catch (error) {
    next(error);
  }
};

/** GET /api/console/ops/invites?used=&q=&page= */
export const listInvites = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const { page, perPage, skip } = parsePage(req);
    const used = req.query.used as string | undefined;
    const q = (req.query.q as string | undefined)?.trim();

    const where: any = {};
    if (used === "true") where.isUsed = true;
    if (used === "false") where.isUsed = false;
    if (q) where.code = { contains: q, mode: "insensitive" };

    const [rows, total, grouped] = await prisma.$transaction([
      prisma.inviteCode.findMany({
        where,
        include: {
          creator: { select: { id: true, username: true, avatar: true } },
          usedByUser: { select: { id: true, username: true, avatar: true, createdAt: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: perPage,
      }),
      prisma.inviteCode.count({ where }),
      prisma.inviteCode.groupBy({ by: ["isUsed"], _count: { _all: true } }),
    ]);

    const stats = { used: 0, unused: 0 };
    for (const g of grouped) {
      if (g.isUsed) stats.used = g._count._all;
      else stats.unused = g._count._all;
    }

    res.json({ success: true, data: { rows, total, page, perPage, stats } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/console/ops/invites  body: { count } */
export const createInvites = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const raw = Number((req.body as any)?.count ?? 1);
    const count = Math.min(25, Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 1));

    const created: { id: string; code: string; createdAt: Date }[] = [];
    for (let i = 0; i < count; i++) {
      // Retry on the (vanishingly unlikely) unique collision rather than 500.
      let code = "";
      for (let attempt = 0; attempt < 5; attempt++) {
        code = crypto.randomBytes(4).toString("hex").toUpperCase();
        const clash = await prisma.inviteCode.findUnique({ where: { code } });
        if (!clash) break;
        code = "";
      }
      if (!code) continue;
      const row = await prisma.inviteCode.create({ data: { code, createdBy: actor.id } });
      created.push({ id: row.id, code: row.code, createdAt: row.createdAt });
    }

    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "ops.invites.create",
      targetType: "invite",
      after: { count: created.length },
      ip: actorIp(req),
    });

    res.json({ success: true, data: created });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/console/ops/invites/:id — only an UNUSED code may be revoked. */
export const revokeInvite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const id = req.params.id as string;
    const invite = await prisma.inviteCode.findUnique({ where: { id } });
    if (!invite) return res.status(404).json({ success: false, message: "Invite not found." });
    if (invite.isUsed) {
      // Deleting a used code would sever the record of who invited whom.
      return res.status(409).json({ success: false, message: "That code has already been used — it can't be revoked." });
    }

    await prisma.inviteCode.delete({ where: { id } });
    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "ops.invites.revoke",
      targetType: "invite",
      targetId: id,
      targetLabel: invite.code,
      ip: actorIp(req),
    });

    res.json({ success: true, message: `Invite ${invite.code} revoked.` });
  } catch (error) {
    next(error);
  }
};

/** POST /api/console/ops/announcements  body: { title, content, tag?, image? } */
export const publishAnnouncement = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const { title, content, tag, image } = req.body as {
      title?: string;
      content?: string;
      tag?: string;
      image?: string;
    };
    if (!title?.trim() || !content?.trim()) {
      return res.status(400).json({ success: false, message: "Title and content are required." });
    }

    const created = await prisma.announcement.create({
      data: {
        authorId: actor.id,
        title: title.trim(),
        content: content.trim(),
        tag: tag?.trim() || "Dev Blog",
        image: image?.trim() || null,
      },
      include: { author: { select: { id: true, username: true, avatar: true } } },
    });

    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "ops.announcement.publish",
      targetType: "announcement",
      targetId: created.id,
      targetLabel: created.title,
      ip: actorIp(req),
    });

    res.json({ success: true, data: created });
  } catch (error) {
    next(error);
  }
};

/**
 * NOTE: announcements created here live only in the DB. seed-announcements.ts
 * WIPES AND RECREATES the announcement table on every deploy, so anything
 * published from the console disappears at the next backend deploy unless it is
 * also added to announcementsData. The UI says this out loud next to the form.
 */

/** GET /api/console/moderation/comments?q=&blessed=&pinned=&page= */
export const listComments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const { page, perPage, skip } = parsePage(req);
    const q = (req.query.q as string | undefined)?.trim();
    const pinned = req.query.pinned as string | undefined;

    const where: any = {};
    if (q) where.content = { contains: q, mode: "insensitive" };
    if (pinned === "true") where.isPinned = true;

    const [rows, total] = await prisma.$transaction([
      prisma.comment.findMany({
        where,
        include: { user: { select: { id: true, username: true, avatar: true, role: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take: perPage,
      }),
      prisma.comment.count({ where }),
    ]);

    res.json({ success: true, data: { rows, total, page, perPage } });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/console/moderation/comments/:id */
export const deleteCommentAsLeadDev = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const id = req.params.id as string;
    const comment = await prisma.comment.findUnique({
      where: { id },
      include: { user: { select: { username: true } } },
    });
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found." });

    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "moderation.comment.delete",
      targetType: "comment",
      targetId: id,
      targetLabel: comment.user?.username,
      before: { content: comment.content.slice(0, 200) },
      note: (req.body as any)?.note,
      ip: actorIp(req),
    });

    await prisma.comment.delete({ where: { id } });
    res.json({ success: true, message: "Comment deleted." });
  } catch (error) {
    next(error);
  }
};

/** POST /api/console/moderation/comments/:id/pin  body: { pinned } */
export const pinCommentAsLeadDev = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const id = req.params.id as string;
    const pinned = !!(req.body as any)?.pinned;

    const exists = await prisma.comment.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return res.status(404).json({ success: false, message: "Comment not found." });

    const updated = await prisma.comment.update({ where: { id }, data: { isPinned: pinned }, select: { id: true, isPinned: true } });

    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "moderation.comment.pin",
      targetType: "comment",
      targetId: id,
      after: { isPinned: pinned },
      ip: actorIp(req),
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

/** GET /api/console/insights — dashboard aggregates. */
export const insights = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const now = Date.now();
    const day = 1000 * 60 * 60 * 24;
    const since7 = new Date(now - 7 * day);
    const since30 = new Date(now - 30 * day);

    const [total, new7, new30, comments7, invitesUnused, announcements, novels, byRole] = await prisma.$transaction([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: since7 } } }),
      prisma.user.count({ where: { createdAt: { gte: since30 } } }),
      prisma.comment.count({ where: { createdAt: { gte: since7 } } }),
      prisma.inviteCode.count({ where: { isUsed: false } }),
      prisma.announcement.count(),
      prisma.novel.count(),
      prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
    ]);

    // Signups per day for the last 14 days, bucketed in JS — one narrow query
    // beats 14 count() round trips on a free-tier database.
    const recent = await prisma.user.findMany({
      where: { createdAt: { gte: new Date(now - 14 * day) } },
      select: { createdAt: true },
    });
    const buckets: { date: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now - i * day);
      buckets.push({ date: d.toISOString().slice(0, 10), count: 0 });
    }
    for (const r of recent) {
      const key = r.createdAt.toISOString().slice(0, 10);
      const b = buckets.find((x) => x.date === key);
      if (b) b.count++;
    }

    const roles: Record<string, number> = {};
    for (const g of byRole) roles[g.role || "USER"] = g._count._all;

    res.json({
      success: true,
      data: { total, new7, new30, comments7, invitesUnused, announcements, novels, roles, signups: buckets },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/console/audit?action=&page= — the console's own activity log. */
export const listAudit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const { page, perPage, skip } = parsePage(req);
    const action = (req.query.action as string | undefined)?.trim();

    // The key is `audit:<iso>:<action>:<rand>` — timestamp first so `key desc`
    // is genuinely newest-first. Because the action is no longer the leading
    // segment, filtering uses `contains` rather than `startsWith`; it still runs
    // in the database, which is the point (Prisma can't reach inside `data`).
    const where: any = action ? { key: { contains: `:${action}:` } } : { key: { startsWith: "audit:" } };

    const [rows, total] = await prisma.$transaction([
      prisma.cacheItem.findMany({ where, orderBy: { key: "desc" }, skip, take: perPage }),
      prisma.cacheItem.count({ where }),
    ]);

    const entries = rows.map((r) => {
      try {
        return { key: r.key, ...JSON.parse(r.data) };
      } catch {
        return { key: r.key, corrupt: true };
      }
    });

    res.json({ success: true, data: { rows: entries, total, page, perPage } });
  } catch (error) {
    next(error);
  }
};
