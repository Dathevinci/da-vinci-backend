import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { CARDS } from "../data/cardCatalog";

/**
 * GUILDS — player-founded groups with a shared board, a treasury and card
 * lending.
 *
 * SECURITY: every write here is JWT-HARD-GATED via getActorId — founding
 * moves currency, joining/leaving moves membership that raids key off, and
 * lending points at other people's cards. No pre-JWT grandfathering.
 *
 * The one-guild-per-user rule lives in the DATABASE (GuildMember.userId is
 * unique), so every membership check here is a fast-path UX courtesy — the
 * constraint is what actually holds under a race, the same way the raid
 * nonce and the gems vote uniqueness do.
 */

const GUILD_CREATE_COST = 2000; // AP
const GUILD_MEMBER_CAP = 30;
const LOAN_MAX_ACTIVE = 3;      // per side: lent by an owner / held by a borrower
const LOAN_DAYS = 7;

// ── Custom roles (Discord-style) ────────────────────────────────────────────
const ROLE_CAP = 10;      // per guild — plain count; a race overshooting by one is accepted
const ROLE_NAME_MIN = 2;
const ROLE_NAME_MAX = 20;

// The ONLY colors a role can wear, exact string match. The value renders as
// an inline style in every member's browser, so free-form input would be a
// CSS-injection surface — nothing outside this list is ever stored.
const ROLE_COLORS = [
  "#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#2dd4bf",
  "#38bdf8", "#818cf8", "#a78bfa", "#e879f9", "#fb7185", "#94a3b8",
] as const;

/** The FULL flag set — anything not listed here does not exist as a grant.
 *  Role management, leadership transfer and co-leader appointment are
 *  identity-gated (leaderId/coLeaderId) and can never ride in on a role. */
type RolePermissions = { editGuild: boolean; kickMembers: boolean; moderateChat: boolean };

/** Normalize unknown JSON to the flag set: known keys only, strict `=== true`,
 *  everything else false — stored permissions never carry surprises. */
function grantsOf(raw: unknown): RolePermissions {
  const p = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  return {
    editGuild: p.editGuild === true,
    kickMembers: p.kickMembers === true,
    moderateChat: p.moderateChat === true,
  };
}

function checkRoleName(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "Invalid role name." };
  const name = raw.trim();
  if (name.length < ROLE_NAME_MIN || name.length > ROLE_NAME_MAX) {
    return { ok: false, message: `Role names are ${ROLE_NAME_MIN}-${ROLE_NAME_MAX} characters.` };
  }
  return { ok: true, value: name };
}

function checkRoleColor(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || !(ROLE_COLORS as readonly string[]).includes(raw)) {
    return { ok: false, message: "Pick a color from the role palette." };
  }
  return { ok: true, value: raw };
}

/** Effective powers of one actor. Officer = the persistent leaderId/coLeaderId
 *  columns (identity-not-username, never the role string); each flag is
 *  officer-or-granted. Custom grants are a strict SUBSET of co-leader power —
 *  nothing here unlocks role management, transfer or co-leader appointment. */
function actorPerms(
  guild: { id: string; leaderId: string; coLeaderId: string | null },
  membership: { userId: string; guildId: string; customRoleId: string | null } | null,
  roles: { id: string; permissions: unknown }[]
): { officer: boolean } & RolePermissions {
  const inGuild = membership && membership.guildId === guild.id ? membership : null;
  const officer = !!inGuild && (guild.leaderId === inGuild.userId || guild.coLeaderId === inGuild.userId);
  const custom = grantsOf(
    inGuild?.customRoleId
      ? roles.find((r) => r.id === inGuild.customRoleId)?.permissions
      : undefined
  );
  return {
    officer,
    editGuild: officer || custom.editGuild,
    kickMembers: officer || custom.kickMembers,
    moderateChat: officer || custom.moderateChat,
  };
}

/** Membership + custom role for one actor, resolved fresh per request — the
 *  standing-fact rule: a kick or a stripped role bites on the very next call.
 *  The role is looked up by id AND guildId, so a stale pointer into another
 *  guild (or a deleted role) grants nothing. */
async function actorPermsFor(
  guild: { id: string; leaderId: string; coLeaderId: string | null },
  actorId: string
) {
  const membership = await prisma.guildMember.findUnique({ where: { userId: actorId } });
  const role =
    membership && membership.guildId === guild.id && membership.customRoleId
      ? await prisma.guildRole.findFirst({ where: { id: membership.customRoleId, guildId: guild.id } })
      : null;
  return actorPerms(guild, membership, role ? [role] : []);
}

/** Level is derived, never stored — floor(xp/1000)+1, so it can't drift. */
const levelOf = (xp: number) => Math.floor(xp / 1000) + 1;

const NAME_MIN = 3;
const NAME_MAX = 24;
const TAG_RE = /^[A-Z]{2,5}$/;

// ── Guild imagery (avatar + banner) ─────────────────────────────────────────
// Same posture as the profileSong check in user.controller.ts: the URL loads
// in VISITORS' browsers, so the gate is https + a host allow-list — Cloudinary
// only, the CDN the rest of the product already serves art from. ONE checker
// for both fields, so the avatar and banner rules can never drift apart.
const GUILD_IMAGE_HOSTS = new Set(["res.cloudinary.com"]);

function checkGuildImage(
  raw: unknown,
  label: "avatar" | "banner"
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, message: `Invalid ${label} link.` };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null }; // empty clears the field

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: "That doesn't look like a valid URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: `Guild ${label} links must start with https://.` };
  }
  if (!GUILD_IMAGE_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, message: `Guild ${label}s must be hosted on res.cloudinary.com.` };
  }
  return { ok: true, value: trimmed };
}

// ── POST /api/guilds ────────────────────────────────────────────────────────
// Found a guild: 2000 AP, name 3-24 chars, tag 2-5 uppercase letters. The
// charge, the log, the guild and the leader membership are ONE transaction —
// a unique-violation on any of them rolls the AP straight back.

export const createGuild = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to found a guild." });
    }

    const name = String(req.body?.name || "").trim();
    const tag = String(req.body?.tag || "").trim().toUpperCase();
    const description = String(req.body?.description ?? "").trim().slice(0, 500);

    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      return res.status(400).json({ success: false, message: `Guild names are ${NAME_MIN}-${NAME_MAX} characters.` });
    }
    if (!TAG_RE.test(tag)) {
      return res.status(400).json({ success: false, message: "Tags are 2-5 uppercase letters, like DVNC." });
    }

    // Fast-path courtesy; the userId unique constraint is the real wall.
    const existing = await prisma.guildMember.findUnique({ where: { userId: actor } });
    if (existing) {
      return res.status(409).json({ success: false, message: "You're already in a guild — leave it before founding one." });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Conditional decrement — the raid Rally pattern. An insufficient
      // balance matches zero rows and the whole founding rolls back.
      const paid = await tx.user.updateMany({
        where: { id: actor, arisePoints: { gte: GUILD_CREATE_COST } },
        data: { arisePoints: { decrement: GUILD_CREATE_COST } },
      });
      if (paid.count === 0) {
        throw Object.assign(new Error("guild-poor"), { guildCode: 402 });
      }
      await tx.pointLog.create({
        data: { userId: actor, amount: -GUILD_CREATE_COST, reason: `Founded guild ${name}` },
      });
      const guild = await tx.guild.create({
        data: { name, tag, description, leaderId: actor },
      });
      await tx.guildMember.create({
        data: { guildId: guild.id, userId: actor, role: "leader" },
      });
      return guild;
    }).catch((e) => {
      if (e?.guildCode === 402) return "poor" as const;
      if (e?.code === "P2002") {
        const t = Array.isArray(e?.meta?.target) ? e.meta.target.join(",") : String(e?.meta?.target || "");
        return t.includes("userId") ? ("member" as const) : ("taken" as const);
      }
      throw e;
    });

    if (result === "poor") {
      return res.status(402).json({ success: false, message: `Founding a guild costs ${GUILD_CREATE_COST} Arise Points and you don't have enough.` });
    }
    if (result === "taken") {
      return res.status(409).json({ success: false, message: "That guild name or tag is already taken." });
    }
    if (result === "member") {
      return res.status(409).json({ success: false, message: "You're already in a guild — leave it before founding one." });
    }

    return res.status(201).json({
      success: true,
      data: {
        id: result.id, name: result.name, tag: result.tag,
        description: result.description, avatar: result.avatar, banner: result.banner,
        leaderId: result.leaderId, coLeaderId: result.coLeaderId,
        shards: result.shards, xp: result.xp,
        level: levelOf(result.xp), memberCount: 1, createdAt: result.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/guilds ─────────────────────────────────────────────────────────

export const listGuilds = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const guilds = await prisma.guild.findMany({
      include: { _count: { select: { members: true } } },
      orderBy: [{ xp: "desc" }, { createdAt: "asc" }],
    });
    res.json({
      success: true,
      data: guilds.map((g) => ({
        id: g.id, name: g.name, tag: g.tag, description: g.description,
        avatar: g.avatar, banner: g.banner,
        leaderId: g.leaderId, coLeaderId: g.coLeaderId,
        shards: g.shards, xp: g.xp,
        level: levelOf(g.xp), memberCount: g._count.members, createdAt: g.createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/guilds/:id ─────────────────────────────────────────────────────

/** The guild-detail payload, shared with setCoLeader and every custom-role
 *  endpoint — which answer with the same shape — so the responses can't drift
 *  apart. Null = no such guild. */
async function guildDetailPayload(id: string, actor: string | null) {
  const guild = await prisma.guild.findUnique({
    where: { id },
    include: { members: { orderBy: { joinedAt: "asc" } } },
  });
  if (!guild) return null;

  const users = guild.members.length
    ? await prisma.user.findMany({
        where: { id: { in: guild.members.map((m) => m.userId) } },
        select: { id: true, username: true, avatar: true },
      })
    : [];

  const myMembership = actor ? guild.members.find((m) => m.userId === actor) || null : null;
  const roles = await prisma.guildRole.findMany({
    where: { guildId: id },
    orderBy: { createdAt: "asc" },
  });
  const activeLoanCount = await prisma.guildCardLoan.count({
    where: { guildId: id, expiresAt: { gt: new Date() } },
  });

  return {
    id: guild.id, name: guild.name, tag: guild.tag,
    description: guild.description, avatar: guild.avatar, banner: guild.banner,
    leaderId: guild.leaderId, coLeaderId: guild.coLeaderId,
    shards: guild.shards, xp: guild.xp,
    level: levelOf(guild.xp), createdAt: guild.createdAt,
    memberCap: GUILD_MEMBER_CAP,
    memberCount: guild.members.length,
    roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.color, permissions: r.permissions })),
    members: guild.members.map((m) => {
      const u = users.find((x) => x.id === m.userId);
      return {
        userId: m.userId,
        username: u?.username || "?",
        avatar: u?.avatar || null,
        role: m.role,
        customRoleId: m.customRoleId,
        joinedAt: m.joinedAt,
      };
    }),
    myMembership: myMembership
      ? { role: myMembership.role, customRoleId: myMembership.customRoleId, joinedAt: myMembership.joinedAt }
      : null,
    activeLoanCount,
  };
}

export const getGuild = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const data = await guildDetailPayload(id, getActorId(req));
    if (!data) return res.status(404).json({ success: false, message: "Guild not found." });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/guilds/of/:userId ──────────────────────────────────────────────
// The profile-page lookup: which guild is this user in? PUBLIC read, no auth
// — guild membership is already public on the guild page, so hiding it here
// would protect nothing. No membership answers data: null, not 404: "not in
// a guild" is a normal state, not an error.

export const guildOfUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.userId as string;

    const membership = await prisma.guildMember.findUnique({ where: { userId } });
    if (!membership) {
      return res.json({ success: true, data: null });
    }

    const guild = await prisma.guild.findUnique({
      where: { id: membership.guildId },
      include: { _count: { select: { members: true } } },
    });
    if (!guild) {
      // Membership row outliving its guild shouldn't happen (deletes cascade),
      // but if it does, answer like a guildless user rather than erroring.
      return res.json({ success: true, data: null });
    }

    // Role from the PERSISTENT leaderId/coLeaderId columns, never the mutable
    // role string on GuildMember — the identity-not-username rule.
    const role =
      guild.leaderId === userId ? "leader" :
      guild.coLeaderId === userId ? "co-leader" : "member";

    res.json({
      success: true,
      data: {
        id: guild.id,
        name: guild.name,
        tag: guild.tag,
        avatar: guild.avatar,
        banner: guild.banner,
        level: levelOf(guild.xp),
        xp: guild.xp,
        shards: guild.shards,
        memberCount: guild._count.members,
        role,
        joinedAt: membership.joinedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/tags ───────────────────────────────────────────────────
// The batch resolver behind the site-wide username chip: a page paints dozens
// of names at once, so this answers ALL of them in TWO queries — memberships,
// then the guilds they point at — never one lookup per id. PUBLIC read for
// guildOfUser's reason: membership is already public on the guild page.
//
// The cap is the real wall. An unbounded id list is a free DB scan for any
// caller, so the array is deduped (100 repeats of one id is one lookup, not a
// rejection) and then hard-capped.

const TAGS_MAX_IDS = 100;

export const guildTags = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = req.body?.userIds;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ success: false, message: "userIds must be an array." });
    }
    // Keep only real strings. String() is NOT safe here: this endpoint is
    // public, and `[{ toString: null, valueOf: null }]` makes ToPrimitive
    // throw — a free 500 for any caller. Non-strings are dropped, not
    // coerced; empty strings match nothing, so they are dropped rather than
    // spent against the cap.
    const ids = Array.from(
      new Set(raw.filter((v): v is string => typeof v === "string"))
    ).filter(Boolean);
    if (ids.length > TAGS_MAX_IDS) {
      return res.status(400).json({ success: false, message: "Too many ids." });
    }
    if (ids.length === 0) {
      return res.json({ success: true, data: {} });
    }

    const members = await prisma.guildMember.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, guildId: true },
    });
    const guildIds = Array.from(new Set(members.map((m) => m.guildId)));
    const guilds = guildIds.length
      ? await prisma.guild.findMany({
          where: { id: { in: guildIds } },
          select: { id: true, name: true, tag: true },
        })
      : [];
    const byId = new Map(guilds.map((g) => [g.id, g]));

    // Only users who are IN a guild get a key. Guildless ids — and a
    // membership row outliving its guild, the hole guildOfUser also absorbs —
    // are simply ABSENT, so the client has one rule ("no key = no guild")
    // instead of a null-vs-missing distinction to get wrong.
    const data: Record<string, { id: string; name: string; tag: string }> = {};
    for (const m of members) {
      const guild = byId.get(m.guildId);
      if (guild) data[m.userId] = { id: guild.id, name: guild.name, tag: guild.tag };
    }

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/:id/join ───────────────────────────────────────────────
// The cap is re-checked under a guild-row lock — N parallel joins would all
// pass a plain count, and 30 is a wall, not a suggestion. The userId unique
// constraint independently stops a double-join.

export const joinGuild = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to join a guild." });
    }
    const id = req.params.id as string;

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });

    const existing = await prisma.guildMember.findUnique({ where: { userId: actor } });
    if (existing) {
      return res.status(409).json({ success: false, message: "You're already in a guild — leave it first." });
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Guild" WHERE id = ${id} FOR UPDATE`;
      const count = await tx.guildMember.count({ where: { guildId: id } });
      if (count >= GUILD_MEMBER_CAP) {
        throw Object.assign(new Error("guild-full"), { guildCode: 409 });
      }
      return tx.guildMember.create({ data: { guildId: id, userId: actor } });
    }).catch((e) => {
      if (e?.guildCode === 409) return "full" as const;
      if (e?.code === "P2002") return "member" as const;
      throw e;
    });

    if (result === "full") {
      return res.status(409).json({ success: false, message: `${guild.name} is full (${GUILD_MEMBER_CAP} members).` });
    }
    if (result === "member") {
      return res.status(409).json({ success: false, message: "You're already in a guild — leave it first." });
    }

    res.json({ success: true, data: { guildId: id, role: result.role, joinedAt: result.joinedAt } });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/leave ──────────────────────────────────────────────────
// A leader can leave ONLY as the last member, which dissolves the guild —
// otherwise the guild would be headless and every leader-only endpoint dead.
// Leaving takes your loans with you, both directions: an ex-member keeping a
// guildmate's card (or their card staying lent into a guild they left) would
// make "fellow member" in the lending rules a one-time check instead of a
// standing fact.

export const leaveGuild = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to leave your guild." });
    }

    const membership = await prisma.guildMember.findUnique({ where: { userId: actor } });
    if (!membership) {
      return res.status(400).json({ success: false, message: "You're not in a guild." });
    }
    const guildId = membership.guildId;

    if (membership.role === "leader") {
      const count = await prisma.guildMember.count({ where: { guildId } });
      if (count > 1) {
        return res.status(409).json({ success: false, message: "Transfer leadership first — a guild can't lose its leader while members remain." });
      }
      // Last member out turns off the lights: loans, roles (no FK, so no
      // cascade — without this sweep they'd outlive the guild as unreachable
      // rows), then the guild (which cascades the membership row).
      await prisma.$transaction([
        prisma.guildCardLoan.deleteMany({ where: { guildId } }),
        prisma.guildRole.deleteMany({ where: { guildId } }),
        prisma.guild.delete({ where: { id: guildId } }),
      ]);
      return res.json({ success: true, data: { left: true, disbanded: true } });
    }

    await prisma.$transaction([
      prisma.guildCardLoan.deleteMany({
        where: { guildId, OR: [{ ownerId: actor }, { borrowerId: actor }] },
      }),
      // A departing co-leader vacates the seat in the same transaction —
      // conditional, so anyone else's leave touches nothing.
      prisma.guild.updateMany({ where: { id: guildId, coLeaderId: actor }, data: { coLeaderId: null } }),
      prisma.guildMember.delete({ where: { userId: actor } }),
    ]);
    res.json({ success: true, data: { left: true, disbanded: false } });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/:id/transfer ───────────────────────────────────────────

export const transferLeadership = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;
    const targetId = String(req.body?.userId || "");
    if (!targetId) {
      return res.status(400).json({ success: false, message: "userId is required." });
    }

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    if (guild.leaderId !== actor) {
      return res.status(403).json({ success: false, message: "Only the guild leader can do that." });
    }
    if (targetId === actor) {
      return res.status(400).json({ success: false, message: "You already lead this guild." });
    }

    const target = await prisma.guildMember.findUnique({ where: { userId: targetId } });
    if (!target || target.guildId !== id) {
      return res.status(404).json({ success: false, message: "That user isn't a member of this guild." });
    }

    // updateMany rather than update for the role flips: a missing row then
    // matches zero instead of aborting the transaction with a P2025.
    await prisma.$transaction([
      prisma.guild.update({ where: { id }, data: { leaderId: targetId } }),
      // A co-leader promoted to leader can't hold both seats — conditional,
      // so transferring to anyone else leaves the deputy in place.
      prisma.guild.updateMany({ where: { id, coLeaderId: targetId }, data: { coLeaderId: null } }),
      prisma.guildMember.updateMany({ where: { userId: actor, guildId: id }, data: { role: "member" } }),
      // customRoleId cleared too: assignRole 400s "the leader can't hold a
      // custom role", so a promotion must not smuggle one past that gate.
      prisma.guildMember.updateMany({ where: { userId: targetId, guildId: id }, data: { role: "leader", customRoleId: null } }),
    ]);
    res.json({ success: true, data: { leaderId: targetId } });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/:id/kick ───────────────────────────────────────────────

export const kickMember = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;
    const targetId = String(req.body?.userId || "");
    if (!targetId) {
      return res.status(400).json({ success: false, message: "userId is required." });
    }

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    // Officers, plus any member whose custom role grants kickMembers.
    const perms = await actorPermsFor(guild, actor);
    if (!perms.kickMembers) {
      return res.status(403).json({ success: false, message: "You don't have permission to kick members." });
    }
    if (targetId === actor) {
      return res.status(400).json({ success: false, message: "You can't kick yourself — use leave." });
    }
    // The self-kick check above already covers the leader kicking the leader,
    // so this only ever bites a co-leader or a custom-role kicker: they
    // outrank members, not the top.
    if (targetId === guild.leaderId) {
      return res.status(403).json({ success: false, message: "The leader can't be kicked." });
    }

    const target = await prisma.guildMember.findUnique({ where: { userId: targetId } });
    if (!target || target.guildId !== id) {
      return res.status(404).json({ success: false, message: "That user isn't a member of this guild." });
    }
    // A custom-role kicker moves PLAIN members only — not the co-leader, and
    // not a fellow kick-holder: peers can't purge peers. Officers keep their
    // existing reach untouched.
    if (!perms.officer) {
      if (targetId === guild.coLeaderId) {
        return res.status(403).json({ success: false, message: "The co-leader can only be kicked by the leader." });
      }
      if (target.customRoleId) {
        const targetRole = await prisma.guildRole.findFirst({
          where: { id: target.customRoleId, guildId: id },
        });
        if (grantsOf(targetRole?.permissions).kickMembers) {
          return res.status(403).json({ success: false, message: "You can't kick a member who also holds kick powers." });
        }
      }
    }

    // Same cleanup as leaving: their loans go with them, both directions.
    await prisma.$transaction([
      prisma.guildCardLoan.deleteMany({
        where: { guildId: id, OR: [{ ownerId: targetId }, { borrowerId: targetId }] },
      }),
      // A kicked co-leader loses the seat in the same transaction —
      // conditional, so kicking anyone else touches nothing.
      prisma.guild.updateMany({ where: { id, coLeaderId: targetId }, data: { coLeaderId: null } }),
      prisma.guildMember.delete({ where: { userId: targetId } }),
    ]);
    res.json({ success: true, data: { kicked: targetId } });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/:id/co-leader ──────────────────────────────────────────
// The leader appoints ONE deputy, or clears the seat with userId: null.
// Leader-only, like transfer — the deputy can't appoint their own successor.
// The membership check runs INSIDE the transaction, beside the write:
// transferLeadership's read-then-write gap would let a target who left
// between the check and the update end up co-leading a guild they're not in.

export const setCoLeader = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;
    const raw = req.body?.userId;
    const targetId = raw === null || raw === undefined || raw === "" ? null : String(raw);

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    if (guild.leaderId !== actor) {
      return res.status(403).json({ success: false, message: "Only the guild leader can do that." });
    }
    if (targetId === actor) {
      return res.status(400).json({ success: false, message: "You already lead this guild — appoint someone else." });
    }

    if (targetId === null) {
      await prisma.guild.update({ where: { id }, data: { coLeaderId: null } });
    } else {
      const result = await prisma.$transaction(async (tx) => {
        // Lock the target's membership row for the length of the tx. Without
        // it, an appoint racing the target's leave/kick can commit AFTER the
        // GuildMember delete (whose conditional coLeaderId clear ran first
        // and matched nothing) — a standing power grant to a non-member. The
        // lock makes the delete wait, so its clear fires after this commits.
        await tx.$executeRaw`SELECT "userId" FROM "GuildMember" WHERE "userId" = ${targetId} FOR UPDATE`;
        const member = await tx.guildMember.findUnique({ where: { userId: targetId } });
        if (!member || member.guildId !== id) {
          throw Object.assign(new Error("co-leader-not-member"), { guildCode: 404 });
        }
        await tx.guild.update({ where: { id }, data: { coLeaderId: targetId } });
        return "ok" as const;
      }).catch((e) => {
        if (e?.guildCode === 404) return "not-member" as const;
        throw e;
      });
      if (result === "not-member") {
        return res.status(404).json({ success: false, message: "That user isn't a member of this guild." });
      }
    }

    const data = await guildDetailPayload(id, actor);
    if (!data) return res.status(404).json({ success: false, message: "Guild not found." });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/:id/roles ──────────────────────────────────────────────
// Role MANAGEMENT (this and the three below) is OFFICER-only, off the
// persistent leaderId/coLeaderId columns — never off a custom grant: a role
// that could mint roles could mint its way to anything. All four answer with
// guildDetailPayload so the UI refreshes from one shape.

export const createRole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    if (guild.leaderId !== actor && guild.coLeaderId !== actor) {
      return res.status(403).json({ success: false, message: "Only the guild leader or co-leader can manage roles." });
    }

    const name = checkRoleName(req.body?.name);
    if (!name.ok) return res.status(400).json({ success: false, message: name.message });
    const color = checkRoleColor(req.body?.color);
    if (!color.ok) return res.status(400).json({ success: false, message: color.message });
    const rawPerms = req.body?.permissions;
    if (rawPerms !== undefined && rawPerms !== null && (typeof rawPerms !== "object" || Array.isArray(rawPerms))) {
      return res.status(400).json({ success: false, message: "Invalid permissions." });
    }
    const permissions = grantsOf(rawPerms);

    // Plain count — a race overshooting the cap by one is accepted here,
    // unlike the member cap where 30 is a wall.
    const count = await prisma.guildRole.count({ where: { guildId: id } });
    if (count >= ROLE_CAP) {
      return res.status(409).json({ success: false, message: `Guilds are capped at ${ROLE_CAP} custom roles.` });
    }

    const role = await prisma.guildRole
      .create({ data: { guildId: id, name: name.value, color: color.value, permissions } })
      .catch((e) => {
        if (e?.code === "P2002") return null; // @@unique([guildId, name])
        throw e;
      });
    if (!role) {
      return res.status(409).json({ success: false, message: "A role with that name already exists." });
    }

    const data = await guildDetailPayload(id, actor);
    if (!data) return res.status(404).json({ success: false, message: "Guild not found." });
    return res.status(201).json({
      success: true,
      data: { ...data, role: { id: role.id, name: role.name, color: role.color, permissions: role.permissions } },
    });
  } catch (error) {
    next(error);
  }
};

// ── PATCH /api/guilds/:id/roles/:roleId ─────────────────────────────────────

export const updateRole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;
    const roleId = req.params.roleId as string;

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    if (guild.leaderId !== actor && guild.coLeaderId !== actor) {
      return res.status(403).json({ success: false, message: "Only the guild leader or co-leader can manage roles." });
    }

    // id AND guildId — a role id from another guild is a 404, not a handle.
    const existing = await prisma.guildRole.findFirst({ where: { id: roleId, guildId: id } });
    if (!existing) return res.status(404).json({ success: false, message: "Role not found." });

    const data: { name?: string; color?: string; permissions?: RolePermissions } = {};
    if (req.body?.name !== undefined) {
      const name = checkRoleName(req.body.name);
      if (!name.ok) return res.status(400).json({ success: false, message: name.message });
      data.name = name.value;
    }
    if (req.body?.color !== undefined) {
      const color = checkRoleColor(req.body.color);
      if (!color.ok) return res.status(400).json({ success: false, message: color.message });
      data.color = color.value;
    }
    if (req.body?.permissions !== undefined) {
      const rawPerms = req.body.permissions;
      if (rawPerms !== null && (typeof rawPerms !== "object" || Array.isArray(rawPerms))) {
        return res.status(400).json({ success: false, message: "Invalid permissions." });
      }
      // Whole-object replace, re-normalized — stored flags never carry more
      // than the three known keys.
      data.permissions = grantsOf(rawPerms);
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update." });
    }

    const updated = await prisma.guildRole
      .update({ where: { id: roleId }, data })
      .catch((e) => {
        if (e?.code === "P2002") return "taken" as const;
        if (e?.code === "P2025") return "gone" as const; // deleted mid-flight
        throw e;
      });
    if (updated === "taken") {
      return res.status(409).json({ success: false, message: "A role with that name already exists." });
    }
    if (updated === "gone") {
      return res.status(404).json({ success: false, message: "Role not found." });
    }

    const payload = await guildDetailPayload(id, actor);
    if (!payload) return res.status(404).json({ success: false, message: "Guild not found." });
    res.json({ success: true, data: payload });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/guilds/:id/roles/:roleId ────────────────────────────────────
// The role and every pointer to it go in ONE transaction — a member row
// keeping a deleted role's id would be a ghost grant waiting to happen.

export const deleteRole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;
    const roleId = req.params.roleId as string;

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    if (guild.leaderId !== actor && guild.coLeaderId !== actor) {
      return res.status(403).json({ success: false, message: "Only the guild leader or co-leader can manage roles." });
    }

    const existing = await prisma.guildRole.findFirst({ where: { id: roleId, guildId: id } });
    if (!existing) return res.status(404).json({ success: false, message: "Role not found." });

    // deleteMany keeps the guildId condition on the destructive half too, and
    // a role already gone matches zero rows instead of aborting on P2025.
    await prisma.$transaction([
      prisma.guildMember.updateMany({ where: { guildId: id, customRoleId: roleId }, data: { customRoleId: null } }),
      prisma.guildRole.deleteMany({ where: { id: roleId, guildId: id } }),
    ]);

    const payload = await guildDetailPayload(id, actor);
    if (!payload) return res.status(404).json({ success: false, message: "Guild not found." });
    res.json({ success: true, data: payload });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/:id/members/:targetId/role ─────────────────────────────
// Assign (roleId) or clear (roleId: null). The leader takes no custom role —
// the seat already carries everything a role could grant. Membership is
// re-checked INSIDE the transaction under the same row lock setCoLeader
// takes, so an assignment can't commit after the target's leave/kick swept
// their membership row.

export const assignRole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;
    const targetId = req.params.targetId as string;
    const raw = req.body?.roleId;
    const roleId = raw === null || raw === undefined || raw === "" ? null : String(raw);

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    if (guild.leaderId !== actor && guild.coLeaderId !== actor) {
      return res.status(403).json({ success: false, message: "Only the guild leader or co-leader can manage roles." });
    }
    if (targetId === guild.leaderId) {
      return res.status(400).json({ success: false, message: "The leader can't hold a custom role." });
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT "userId" FROM "GuildMember" WHERE "userId" = ${targetId} FOR UPDATE`;
      const member = await tx.guildMember.findUnique({ where: { userId: targetId } });
      if (!member || member.guildId !== id) {
        throw Object.assign(new Error("role-target-not-member"), { guildCode: 404, guildWho: "member" });
      }
      if (roleId) {
        // id AND guildId — a role from another guild is not a handle here.
        const role = await tx.guildRole.findFirst({ where: { id: roleId, guildId: id } });
        if (!role) {
          throw Object.assign(new Error("role-not-found"), { guildCode: 404, guildWho: "role" });
        }
      }
      await tx.guildMember.update({ where: { userId: targetId }, data: { customRoleId: roleId } });
      return "ok" as const;
    }).catch((e) => {
      if (e?.guildCode === 404) return e?.guildWho === "role" ? ("no-role" as const) : ("not-member" as const);
      throw e;
    });
    if (result === "not-member") {
      return res.status(404).json({ success: false, message: "That user isn't a member of this guild." });
    }
    if (result === "no-role") {
      return res.status(404).json({ success: false, message: "Role not found." });
    }

    const data = await guildDetailPayload(id, actor);
    if (!data) return res.status(404).json({ success: false, message: "Guild not found." });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ── PATCH /api/guilds/:id ───────────────────────────────────────────────────
// Description, avatar and banner only. Name and tag are immutable in v1 —
// they're unique identity, and renames are exactly the mutable-key trap the
// identity memory warns about.

export const updateGuild = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    // Profile edits are shared power: officers, plus any member whose custom
    // role grants editGuild — exactly this endpoint's fields, nothing more.
    const perms = await actorPermsFor(guild, actor);
    if (!perms.editGuild) {
      return res.status(403).json({ success: false, message: "You don't have permission to edit this guild." });
    }

    const data: { description?: string; avatar?: string | null; banner?: string | null } = {};
    if (req.body?.description !== undefined) {
      if (typeof req.body.description !== "string") {
        return res.status(400).json({ success: false, message: "Invalid description." });
      }
      const d = req.body.description.trim();
      if (d.length > 500) {
        return res.status(400).json({ success: false, message: "Descriptions are capped at 500 characters." });
      }
      data.description = d;
    }
    if (req.body?.avatar !== undefined) {
      const check = checkGuildImage(req.body.avatar, "avatar");
      if (!check.ok) return res.status(400).json({ success: false, message: check.message });
      data.avatar = check.value;
    }
    if (req.body?.banner !== undefined) {
      const check = checkGuildImage(req.body.banner, "banner");
      if (!check.ok) return res.status(400).json({ success: false, message: check.message });
      data.banner = check.value;
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update." });
    }

    const updated = await prisma.guild.update({ where: { id }, data });
    res.json({ success: true, data: { description: updated.description, avatar: updated.avatar, banner: updated.banner } });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/:id/loans ──────────────────────────────────────────────
// The OWNER lends to a fellow member. Caps: max 3 active out per owner, max
// 3 active held per borrower — counted EXCLUDING the exact triple being
// upserted, so refreshing an existing loan is never blocked by the loan it
// refreshes.

export const createLoan = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to lend a card." });
    }
    const guildId = req.params.id as string;
    const cardId = String(req.body?.cardId || "");
    const borrowerId = String(req.body?.borrowerId || "");
    if (!cardId || !borrowerId) {
      return res.status(400).json({ success: false, message: "cardId and borrowerId are required." });
    }
    if (borrowerId === actor) {
      return res.status(400).json({ success: false, message: "You can't lend a card to yourself." });
    }
    if (!CARDS[cardId]) {
      return res.status(400).json({ success: false, message: "Unknown card." });
    }

    const [me, them] = await Promise.all([
      prisma.guildMember.findUnique({ where: { userId: actor } }),
      prisma.guildMember.findUnique({ where: { userId: borrowerId } }),
    ]);
    if (!me || me.guildId !== guildId) {
      return res.status(403).json({ success: false, message: "You're not a member of this guild." });
    }
    if (!them || them.guildId !== guildId) {
      return res.status(400).json({ success: false, message: "The borrower must be a member of this guild." });
    }

    const owned = await prisma.userCard.findFirst({
      where: { userId: actor, cardId, count: { gt: 0 } },
    });
    if (!owned) {
      return res.status(400).json({ success: false, message: "You don't own that card." });
    }

    const now = new Date();
    const [lentActive, borrowedActive] = await Promise.all([
      prisma.guildCardLoan.count({
        where: { ownerId: actor, expiresAt: { gt: now }, NOT: { cardId, borrowerId } },
      }),
      prisma.guildCardLoan.count({
        where: { borrowerId, expiresAt: { gt: now }, NOT: { cardId, ownerId: actor } },
      }),
    ]);
    if (lentActive >= LOAN_MAX_ACTIVE) {
      return res.status(409).json({ success: false, message: `You already have ${LOAN_MAX_ACTIVE} cards out on loan.` });
    }
    if (borrowedActive >= LOAN_MAX_ACTIVE) {
      return res.status(409).json({ success: false, message: `They're already borrowing ${LOAN_MAX_ACTIVE} cards.` });
    }

    const expiresAt = new Date(Date.now() + LOAN_DAYS * 86400000);
    const loan = await prisma.guildCardLoan.upsert({
      where: { ownerId_cardId_borrowerId: { ownerId: actor, cardId, borrowerId } },
      update: { expiresAt, guildId },
      create: { guildId, ownerId: actor, borrowerId, cardId, expiresAt },
    });

    res.json({
      success: true,
      data: {
        id: loan.id, guildId: loan.guildId, cardId: loan.cardId,
        cardName: CARDS[cardId]?.name || cardId,
        borrowerId: loan.borrowerId, expiresAt: loan.expiresAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/guilds/loans/:loanId ────────────────────────────────────────
// Either side can end it early — an owner recalls, a borrower returns.

export const endLoan = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const loanId = req.params.loanId as string;

    const loan = await prisma.guildCardLoan.findUnique({ where: { id: loanId } });
    if (!loan) return res.status(404).json({ success: false, message: "Loan not found." });
    if (loan.ownerId !== actor && loan.borrowerId !== actor) {
      return res.status(403).json({ success: false, message: "Only the owner or the borrower can end a loan." });
    }

    await prisma.guildCardLoan.delete({ where: { id: loanId } });
    res.json({ success: true, data: { ended: loanId } });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/guilds/mine/loans ──────────────────────────────────────────────

export const myLoans = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to see your loans." });
    }
    const now = new Date();

    const loans = await prisma.guildCardLoan.findMany({
      where: { OR: [{ ownerId: actor }, { borrowerId: actor }] },
      orderBy: { expiresAt: "asc" },
    });

    const otherIds = Array.from(
      new Set(loans.map((l) => (l.ownerId === actor ? l.borrowerId : l.ownerId)))
    );
    const users = otherIds.length
      ? await prisma.user.findMany({
          where: { id: { in: otherIds } },
          select: { id: true, username: true, avatar: true },
        })
      : [];

    const shape = (l: (typeof loans)[number]) => {
      const otherId = l.ownerId === actor ? l.borrowerId : l.ownerId;
      const u = users.find((x) => x.id === otherId);
      return {
        id: l.id,
        guildId: l.guildId,
        cardId: l.cardId,
        cardName: CARDS[l.cardId]?.name || l.cardId,
        ownerId: l.ownerId,
        borrowerId: l.borrowerId,
        counterpartyId: otherId,
        counterpartyName: u?.username || "?",
        counterpartyAvatar: u?.avatar || null,
        expiresAt: l.expiresAt,
        active: l.expiresAt > now,
      };
    };

    res.json({
      success: true,
      data: {
        lent: loans.filter((l) => l.ownerId === actor).map(shape),
        borrowed: loans.filter((l) => l.borrowerId === actor).map(shape),
      },
    });
  } catch (error) {
    next(error);
  }
};
