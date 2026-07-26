import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { requireStaff } from "../lib/staff";
import { writeAudit, actorIp } from "../lib/audit";
import {
  isAllowedRole,
  leadDevCount,
  validateAmount,
  checkApBrake,
  assertNotSelf,
  parsePage,
  confirmMatches,
} from "../lib/consoleGuards";
import { SHOP_CATALOG, PURCHASED_FIELD, isAvailable } from "../data/shopCatalog";
import { getRole } from "../utils/economy";

/**
 * Lead Dev console — users, roles and economy.
 *
 * EVERY handler in this file, INCLUDING reads, opens with:
 *     const actor = await requireStaff(req, res, { leadDevOnly: true });
 *     if (!actor) return;
 *
 * Reads are gated too because these payloads carry email addresses and invite
 * graphs. An ADMIN token gets a 403 exactly like an anonymous request — the
 * whole point of this console is that it is NOT an admin surface.
 *
 * The actor is NEVER read from req.body. Only the TARGET comes from params/body.
 * This file must never re-inline a username allowlist; role resolution lives in
 * staff.ts alone.
 */

// Columns safe to return. `password` must never appear here.
const USER_SELECT = {
  id: true,
  username: true,
  email: true,
  avatar: true,
  createdAt: true,
  arisePoints: true,
  xp: true,
  role: true,
  isAdmin: true,
  isPrivate: true,
  activeEffect: true,
  activeFrame: true,
  purchasedEffects: true,
  purchasedFrames: true,
  usernameChanges: true,
  discordId: true,
} as const;

/** GET /api/console/me — the UI treats a 403 here as authoritative. */
export const consoleSession = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;
    res.json({
      success: true,
      data: {
        id: actor.id,
        username: actor.username,
        role: actor.role,
        isLeadDev: actor.isLeadDev,
        serverTime: new Date().toISOString(),
        env: process.env.NODE_ENV || "development",
      },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/console/users?q=&role=&sort=&dir=&page=&perPage= */
export const listUsers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const { page, perPage, skip } = parsePage(req);
    const q = (req.query.q as string | undefined)?.trim();
    const role = req.query.role as string | undefined;
    const sortRaw = (req.query.sort as string | undefined) || "createdAt";
    const dir = (req.query.dir as string | undefined) === "asc" ? "asc" : "desc";

    // Allowlist the sort column — an arbitrary string here is a Prisma throw.
    const sortable = ["createdAt", "username", "arisePoints", "xp"];
    const sort = sortable.includes(sortRaw) ? sortRaw : "createdAt";

    const where: any = {};
    if (q) {
      where.OR = [
        { username: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }
    if (role && isAllowedRole(role)) where.role = role;

    const [rows, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        select: {
          ...USER_SELECT,
          _count: { select: { comments: true, followers: true, following: true, pointLogs: true, createdInvites: true } },
        },
        // Cast: a computed key yields an index signature, which does not satisfy
        // Prisma's UserOrderByWithRelationInput under strict mode. `sort` is
        // allowlisted above, so this is safe.
        orderBy: { [sort]: dir } as any,
        skip,
        take: perPage,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ success: true, data: { rows, total, page, perPage } });
  } catch (error) {
    next(error);
  }
};

/** GET /api/console/users/:id — full dossier for the detail drawer. */
export const getUserDossier = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const id = req.params.id as string;
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        ...USER_SELECT,
        bio: true,
        bannerUrl: true,
        activeTag: true,
        activeRole: true,
        purchasedTags: true,
        purchasedRoles: true,
        pointLogs: { orderBy: { createdAt: "desc" }, take: 20 },
        createdInvites: {
          orderBy: { createdAt: "desc" },
          take: 25,
          include: { usedByUser: { select: { id: true, username: true, avatar: true } } },
        },
        usedInvite: { select: { code: true, createdAt: true, createdBy: true } },
        _count: { select: { comments: true, followers: true, following: true, watchlist: true, pointLogs: true, createdInvites: true } },
      },
    });
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    // Donation has no FK to User — match on the denormalized column.
    const donations = await prisma.donation.findMany({
      where: { matchedUserId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    res.json({ success: true, data: { user, donations } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/console/users/:id/role  body: { role, confirmUsername?, note? } */
export const setUserRole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const id = req.params.id as string;
    const { role, confirmUsername, note } = req.body as { role?: string; confirmUsername?: string; note?: string };

    // Hard wall: a self-demotion here would be unrecoverable without direct SQL.
    const selfErr = assertNotSelf(actor, id, "change the role of");
    if (selfErr) return res.status(400).json({ success: false, message: selfErr });

    // Allowlist FIRST. Writing "admin" lowercase would make resolveActor compute
    // isStaff:false AND block the getRole fallback — a silent total lockout.
    if (!isAllowedRole(role)) {
      return res.status(400).json({ success: false, message: "Role must be USER, ADMIN or LEAD_DEV." });
    }

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true, role: true } });
    if (!target) return res.status(404).json({ success: false, message: "User not found." });

    // Promoting to LEAD_DEV hands over the keys — type-to-confirm, server-verified.
    if (role === "LEAD_DEV" && !confirmMatches(confirmUsername, target.username)) {
      return res.status(400).json({
        success: false,
        message: `Type ${target.username} to confirm promoting them to Lead Dev.`,
      });
    }

    // Never strand the platform without an owner.
    if (target.role === "LEAD_DEV" && role !== "LEAD_DEV") {
      if ((await leadDevCount()) <= 1) {
        return res.status(409).json({ success: false, message: "That's the last Lead Dev — promote someone else first." });
      }
    }

    /**
     * Refuse a demotion that wouldn't actually take effect.
     *
     * resolveActor falls back to getRole(username) whenever the role column
     * reads "USER", and backfill-roles.ts re-asserts the username-based role on
     * every deploy. So writing "USER" for an account whose NAME grants staff was
     * silently a no-op: the console reported success, the audit log recorded a
     * demotion, and the user kept every power — then the next deploy wrote the
     * old role back into the authoritative column.
     *
     * Reporting the truth beats a success toast that isn't true. Removing the
     * name from the lists in utils/economy.ts and backfill-roles.ts is a code
     * change, so it can't be done from here.
     */
    const nameGrants = getRole(target.username);
    if (nameGrants !== "USER" && role === "USER") {
      return res.status(409).json({
        success: false,
        message: `"${target.username}" is hardcoded as ${nameGrants} by username, so demoting to USER here would not take effect. Remove the name from the role lists in the codebase, or rename the account first.`,
      });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { role, isAdmin: role === "ADMIN" || role === "LEAD_DEV" },
      select: { id: true, username: true, role: true, isAdmin: true },
    });

    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "user.role.set",
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      before: { role: target.role },
      after: { role },
      note,
      ip: actorIp(req),
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

/** POST /api/console/users/:id/points  body: { amount, reason, notify? } */
export const adjustPoints = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const id = req.params.id as string;
    const { reason, notify, note } = req.body as { reason?: string; notify?: boolean; note?: string };

    const parsed = validateAmount((req.body as any).amount);
    if (!parsed.ok) return res.status(400).json({ success: false, message: parsed.message });
    const amount = parsed.amount;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, message: "A reason is required — it goes on the public ledger." });
    }

    const brake = checkApBrake(actor.id, amount);
    if (!brake.ok) return res.status(429).json({ success: false, message: brake.message });

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true, arisePoints: true } });
    if (!target) return res.status(404).json({ success: false, message: "User not found." });

    // Clamp instead of driving a balance negative.
    const applied = amount < 0 ? -Math.min(Math.abs(amount), target.arisePoints) : amount;
    const clamped = applied !== amount;

    // NOTE: GET /api/users/:id/point-logs is UNAUTHENTICATED, so this `reason`
    // string is PUBLIC. Never put an email, an IP, or a rationale about private
    // conduct in it — operator notes go to the audit log only.
    const ops: any[] = [
      prisma.user.update({ where: { id }, data: { arisePoints: { increment: applied } } }),
      prisma.pointLog.create({
        data: { userId: id, amount: applied, reason: `Console: ${reason.trim()} — by ${actor.username}` },
      }),
    ];
    if (notify) {
      ops.push(
        prisma.notification.create({
          data: {
            userId: id,
            actorId: actor.id,
            type: applied > 0 ? "ARISE_POINTS_GRANT" : "ARISE_POINTS_ADJUST",
            message:
              applied > 0
                ? `You received ${applied.toLocaleString()} Arise Points.`
                : `${Math.abs(applied).toLocaleString()} Arise Points were removed from your balance.`,
            link: "/shop",
          },
        })
      );
    }

    const [updated] = await prisma.$transaction(ops);

    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "user.points.adjust",
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      before: { arisePoints: target.arisePoints },
      after: { arisePoints: (updated as any).arisePoints },
      note: note || reason,
      ip: actorIp(req),
    });

    res.json({
      success: true,
      data: { id, username: target.username, arisePoints: (updated as any).arisePoints, delta: applied, clamped },
    });
  } catch (error) {
    next(error);
  }
};

/** POST /api/console/users/:id/grant-item  body: { itemId, allowExpired?, notify? } */
export const grantItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const id = req.params.id as string;
    const { itemId, allowExpired, notify, note } = req.body as {
      itemId?: string;
      allowExpired?: boolean;
      notify?: boolean;
      note?: string;
    };

    if (!itemId || !SHOP_CATALOG[itemId]) {
      return res.status(400).json({ success: false, message: "Unknown item id." });
    }
    const item = SHOP_CATALOG[itemId]!;
    if (!isAvailable(item) && !allowExpired) {
      return res.status(410).json({
        success: false,
        message: "That item's limited window has closed. Re-send with allowExpired to grant it anyway.",
      });
    }
    const field = PURCHASED_FIELD[item.type];

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true, [field]: true } as any });
    if (!target) return res.status(404).json({ success: false, message: "User not found." });

    const owned = (((target as any)[field] as string[]) || []);
    if (owned.includes(itemId)) {
      return res.json({ success: true, data: { itemId, alreadyOwned: true } });
    }

    const ops: any[] = [
      prisma.user.update({ where: { id }, data: { [field]: { push: itemId } } }),
      // Zero-value log line so the grant shows up in the user's own history.
      prisma.pointLog.create({
        data: { userId: id, amount: 0, reason: `Console: granted "${itemId}" — by ${actor.username}` },
      }),
    ];
    if (notify !== false) {
      ops.push(
        prisma.notification.create({
          data: {
            userId: id,
            actorId: actor.id,
            type: "gift",
            message: `A gift landed in your inventory — open Shop → Owned to equip it.`,
            link: "/shop",
          },
        })
      );
    }
    await prisma.$transaction(ops);

    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "user.item.grant",
      targetType: "user",
      targetId: target.id,
      targetLabel: (target as any).username,
      after: { itemId },
      note,
      ip: actorIp(req),
    });

    res.json({ success: true, data: { itemId, alreadyOwned: false } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/console/users/:id/revoke-item  body: { itemId, confirmUsername, refund? } */
export const revokeItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const id = req.params.id as string;
    const { itemId, confirmUsername, refund, note } = req.body as {
      itemId?: string;
      confirmUsername?: string;
      refund?: boolean;
      note?: string;
    };

    if (!itemId || !SHOP_CATALOG[itemId]) {
      return res.status(400).json({ success: false, message: "Unknown item id." });
    }
    const item = SHOP_CATALOG[itemId]!;
    const field = PURCHASED_FIELD[item.type];
    const activeField = item.type === "effect" ? "activeEffect" : "activeFrame";

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, arisePoints: true, [field]: true, [activeField]: true } as any,
    });
    if (!target) return res.status(404).json({ success: false, message: "User not found." });

    // Taking away something someone paid for — type-to-confirm, server-verified.
    if (!confirmMatches(confirmUsername, (target as any).username)) {
      return res.status(400).json({
        success: false,
        message: `Type ${(target as any).username} to confirm revoking a purchased item.`,
      });
    }

    const owned = (((target as any)[field] as string[]) || []);
    if (!owned.includes(itemId)) {
      return res.status(409).json({ success: false, message: "They don't own that item." });
    }

    const data: any = { [field]: { set: owned.filter((x) => x !== itemId) } };
    // Don't leave them wearing something they no longer own.
    if ((target as any)[activeField] === itemId) data[activeField] = null;
    if (refund) data.arisePoints = { increment: item.price };

    const ops: any[] = [prisma.user.update({ where: { id }, data })];
    if (refund) {
      ops.push(
        prisma.pointLog.create({
          data: { userId: id, amount: item.price, reason: `Console: refund for "${itemId}" — by ${actor.username}` },
        })
      );
    }
    await prisma.$transaction(ops);

    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "user.item.revoke",
      targetType: "user",
      targetId: (target as any).id,
      targetLabel: (target as any).username,
      before: { owned: true },
      after: { itemId, refunded: !!refund },
      note,
      ip: actorIp(req),
    });

    res.json({ success: true, data: { itemId, refunded: !!refund } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/console/users/:id/notify  body: { message, link?, type? } */
export const notifyUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const id = req.params.id as string;
    const { message, link, type } = req.body as { message?: string; link?: string; type?: string };
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: "Message is required." });
    }
    if (message.length > 300) {
      return res.status(400).json({ success: false, message: "Message must be 300 characters or fewer." });
    }

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true } });
    if (!target) return res.status(404).json({ success: false, message: "User not found." });

    const created = await prisma.notification.create({
      data: { userId: id, actorId: actor.id, type: type || "info", message: message.trim(), link: link || null },
    });

    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "user.notify",
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      after: { message: message.trim() },
      ip: actorIp(req),
    });

    res.json({ success: true, data: { id: created.id } });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/console/users/:id  body: { confirmUsername, note? } */
export const deleteUserAccount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const id = req.params.id as string;
    const { confirmUsername, note } = req.body as { confirmUsername?: string; note?: string };

    const selfErr = assertNotSelf(actor, id, "delete");
    if (selfErr) {
      return res.status(400).json({ success: false, message: `${selfErr} Use Settings if you really mean to.` });
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, role: true, arisePoints: true, _count: { select: { comments: true, followers: true } } },
    });
    if (!target) return res.status(404).json({ success: false, message: "User not found." });

    if (!confirmMatches(confirmUsername, target.username)) {
      return res.status(400).json({ success: false, message: `Type ${target.username} to confirm deletion.` });
    }

    if (target.role === "LEAD_DEV" && (await leadDevCount()) <= 1) {
      return res.status(409).json({ success: false, message: "That's the last Lead Dev — you can't delete them." });
    }

    // Audit BEFORE the delete: targetLabel is denormalized so the entry stays
    // readable once the row is gone.
    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "user.delete",
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      before: { role: target.role, arisePoints: target.arisePoints, comments: target._count.comments },
      note,
      ip: actorIp(req),
    });

    await prisma.user.delete({ where: { id } });

    res.json({ success: true, message: `${target.username} deleted.` });
  } catch (error) {
    next(error);
  }
};

/** GET /api/console/economy/overview */
export const economyOverview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const [supply, minted, burned, top, donations, userCount] = await prisma.$transaction([
      prisma.user.aggregate({ _sum: { arisePoints: true }, _avg: { arisePoints: true } }),
      prisma.pointLog.aggregate({ _sum: { amount: true }, where: { amount: { gt: 0 } } }),
      prisma.pointLog.aggregate({ _sum: { amount: true }, where: { amount: { lt: 0 } } }),
      prisma.user.findMany({
        orderBy: { arisePoints: "desc" },
        take: 10,
        select: { id: true, username: true, avatar: true, arisePoints: true, role: true },
      }),
      prisma.donation.aggregate({ _sum: { amount: true, apGranted: true }, _count: true }),
      prisma.user.count(),
    ]);

    res.json({
      success: true,
      data: {
        circulating: supply._sum.arisePoints || 0,
        average: Math.round(supply._avg.arisePoints || 0),
        minted: minted._sum.amount || 0,
        burned: Math.abs(burned._sum.amount || 0),
        topHolders: top,
        donations: {
          count: donations._count,
          total: donations._sum.amount || 0,
          apGranted: donations._sum.apGranted || 0,
        },
        userCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/console/economy/ledger?userId=&q=&sign=&page= */
export const economyLedger = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const { page, perPage, skip } = parsePage(req);
    const userId = req.query.userId as string | undefined;
    const q = (req.query.q as string | undefined)?.trim();
    const sign = req.query.sign as string | undefined;

    const where: any = {};
    if (userId) where.userId = userId;
    if (q) where.reason = { contains: q, mode: "insensitive" };
    if (sign === "credit") where.amount = { gt: 0 };
    if (sign === "debit") where.amount = { lt: 0 };

    const [rows, total] = await prisma.$transaction([
      prisma.pointLog.findMany({
        where,
        include: { user: { select: { id: true, username: true, avatar: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take: perPage,
      }),
      prisma.pointLog.count({ where }),
    ]);

    res.json({ success: true, data: { rows, total, page, perPage } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/console/economy/ledger/:id/reverse
 * Append-only correction — never edits or deletes the original row.
 */
export const reverseLedgerEntry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    const id = req.params.id as string;
    const { note } = req.body as { note?: string };

    const entry = await prisma.pointLog.findUnique({ where: { id }, include: { user: { select: { id: true, username: true, arisePoints: true } } } });
    if (!entry) return res.status(404).json({ success: false, message: "Ledger entry not found." });
    if (entry.amount === 0) return res.status(400).json({ success: false, message: "That entry moved no points." });

    // Don't let the same entry be reversed twice.
    const already = await prisma.pointLog.findFirst({ where: { userId: entry.userId, reason: { contains: `reversal of ${entry.id}` } } });
    if (already) return res.status(409).json({ success: false, message: "That entry has already been reversed." });

    const delta = -entry.amount;
    const applied = delta < 0 ? -Math.min(Math.abs(delta), entry.user.arisePoints) : delta;

    const [updated] = await prisma.$transaction([
      prisma.user.update({ where: { id: entry.userId }, data: { arisePoints: { increment: applied } } }),
      prisma.pointLog.create({
        data: { userId: entry.userId, amount: applied, reason: `Console: reversal of ${entry.id} — by ${actor.username}` },
      }),
    ]);

    await writeAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "economy.ledger.reverse",
      targetType: "pointLog",
      targetId: entry.id,
      targetLabel: entry.user.username,
      before: { amount: entry.amount, reason: entry.reason },
      after: { applied, arisePoints: (updated as any).arisePoints },
      note,
      ip: actorIp(req),
    });

    res.json({ success: true, data: { reversedId: entry.id, amount: applied, arisePoints: (updated as any).arisePoints } });
  } catch (error) {
    next(error);
  }
};

/** GET /api/console/shop/catalog — ownership tallies without N count() calls. */
export const shopCatalogStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

    // One pass over a narrow projection, tallied in JS — 24 catalog entries would
    // otherwise mean 48 count() round trips against a free-tier Postgres.
    const users = await prisma.user.findMany({
      select: { purchasedEffects: true, purchasedFrames: true, activeEffect: true, activeFrame: true },
    });

    const owners: Record<string, number> = {};
    const equipped: Record<string, number> = {};
    for (const u of users) {
      for (const e of u.purchasedEffects || []) owners[e] = (owners[e] || 0) + 1;
      for (const f of u.purchasedFrames || []) owners[f] = (owners[f] || 0) + 1;
      if (u.activeEffect) equipped[u.activeEffect] = (equipped[u.activeEffect] || 0) + 1;
      if (u.activeFrame) equipped[u.activeFrame] = (equipped[u.activeFrame] || 0) + 1;
    }

    const rows = Object.entries(SHOP_CATALOG).map(([id, item]) => ({
      id,
      type: item.type,
      price: item.price,
      availableUntil: (item as any).availableUntil ?? null,
      available: isAvailable(item),
      owners: owners[id] || 0,
      equipped: equipped[id] || 0,
    }));

    res.json({ success: true, data: { rows, userCount: users.length } });
  } catch (error) {
    next(error);
  }
};
