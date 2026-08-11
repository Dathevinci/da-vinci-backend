import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { CARDS } from "../data/cardCatalog";
// The USER level curve — one owner, imported, never restated (see the USER
// level note below and the header of economy.ts).
import { USER_MAX_LEVEL, userLevel } from "../utils/economy";

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
const GUILD_CREATE_MIN_ACCOUNT_DAYS = 3; // account age required to FOUND one
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

// ═══ GUILD PROGRESSION ══════════════════════════════════════════════════════
// THE SERVER IS THE ONLY PLACE THIS MATH LIVES. The client renders the block
// the API sends and never recomputes a level — one curve, one owner, so a
// bar on the page can never disagree with the cap the server enforces.
//
//   levelCost(L)  = 300 + (L-1)*60                 xp to go from L to L+1
//   totalXpFor(L) = 300*(L-1) + 60*(L-1)*(L-2)/2   cumulative xp AT level L
//   level 100 = 320,760 total xp — the ceiling.
//
// Level is DERIVED from xp, never stored, so it cannot drift from the number
// that defines it (the old curve was floor(xp/1000)+1 with no ceiling).

export const GUILD_MAX_LEVEL = 100;
/** The wall no amount of levelling or buying gets past. */
export const GUILD_HARD_MEMBER_CAP = 100;

/** Clamp anything a caller hands us into a real level. */
const asLevel = (level: number): number => {
  const L = Math.floor(Number(level));
  if (!Number.isFinite(L)) return 1;
  return Math.max(1, Math.min(GUILD_MAX_LEVEL, L));
};

/** Clamp anything a caller hands us into a real xp total. */
const asXp = (xp: number): number => {
  const x = Math.floor(Number(xp));
  return Number.isFinite(x) ? Math.max(0, x) : 0;
};

/** XP to go from `level` to the next one. Flat past the ceiling. */
export const levelCost = (level: number): number => 300 + (asLevel(level) - 1) * 60;

/** Cumulative XP a guild must have banked to BE at `level`. */
export const totalXpFor = (level: number): number => {
  const L = asLevel(level);
  return 300 * (L - 1) + (60 * (L - 1) * (L - 2)) / 2;
};

/** The largest level in [1,100] whose entry cost this xp has paid. */
export const guildLevel = (xp: number): number => {
  const x = asXp(xp);
  let level = 1;
  while (level < GUILD_MAX_LEVEL && x >= totalXpFor(level + 1)) level++;
  return level;
};

// ── Custom emoji slots ──────────────────────────────────────────────────────
// A LEVEL REWARD, not a purchase: no new currency, no new column, nothing to
// buy. Guild xp already gates member seats; this gives it a second meaning on
// the SAME curve, so levelling past the seat ceiling still pays for something.
//
//   emojiSlots(level) = min(25, 5 + floor(level / 5))
//   L1 = 5 · L25 = 10 · L50 = 15 · L100 = 25 (and 25 is the ceiling)
//
// Derived from level like every other guild number, so capacity can never
// drift from the xp that defines it.
export const EMOJI_SLOTS_BASE = 5;
export const EMOJI_SLOTS_MAX = 25;
const EMOJI_LEVELS_PER_SLOT = 5;

export const emojiSlots = (level: number): number =>
  Math.min(EMOJI_SLOTS_MAX, EMOJI_SLOTS_BASE + Math.floor(asLevel(level) / EMOJI_LEVELS_PER_SLOT));

/** Seats: 10 at level 1, +0.8 per level, plus whatever the treasury bought —
 *  never past the hard cap of 100. (L79 = 72, L100 = 89, + bought slots.) */
export const memberCap = (level: number, purchasedSlots: number): number => {
  const bought = Math.max(0, Math.floor(Number(purchasedSlots)) || 0);
  return Math.min(GUILD_HARD_MEMBER_CAP, 10 + Math.floor((asLevel(level) - 1) * 0.8) + bought);
};

/** The whole progression answer for one guild, in ONE shape — every payload
 *  that mentions a level spreads this, so no endpoint can invent its own.
 *
 *  At level 100 `isMax` is true and BOTH xpIntoLevel and xpForNextLevel are 0,
 *  so a client subtracting one from the other reads 0 and the bar reads full
 *  and "MAX" — there is deliberately no negative "xp to next level" at the
 *  ceiling. */
export function levelBlock(xp: number, purchasedSlots: number) {
  const x = asXp(xp);
  const level = guildLevel(x);
  const isMax = level >= GUILD_MAX_LEVEL;
  const xpForNextLevel = isMax ? 0 : levelCost(level);
  const xpIntoLevel = isMax ? 0 : x - totalXpFor(level);
  return {
    level,
    xp: x,
    xpIntoLevel,
    xpForNextLevel,
    progressPct: isMax
      ? 100
      : Math.min(100, Math.max(0, Math.round((xpIntoLevel / xpForNextLevel) * 100))),
    maxLevel: GUILD_MAX_LEVEL,
    isMax,
    memberCap: memberCap(level, purchasedSlots),
  };
}

// ═══ GUILD ECONOMY ══════════════════════════════════════════════════════════
// Every tunable number in ONE object. Members feed their guild: personal xp
// earned anywhere on the site also pays the guild a cut, and the treasury
// takes shards alongside that xp.
//
// TREASURY = CLOSED LOOP. Shards go IN (raid kills, the xp cut, member
// donations) and are only ever SPENT on the purchases below. There is NO path
// that moves treasury shards into a personal balance — see the debit sites.
export const GUILD_ECONOMY = {
  /** The guild gains floor(memberXp * this) whenever a member earns xp. */
  MEMBER_XP_SHARE: 0.5,
  /** While xpBoostUntil is in the future, the guild's CUT is multiplied by
   *  this. The member's own xp is untouched — the boost is the guild's. */
  XP_BOOST_MULTIPLIER: 1.25,
  XP_BOOST_DAYS: 7,
  /** Treasury takes floor(guildXpGained / this) shards alongside the xp
   *  (the reference's "5 coins per 25 xp"). */
  XP_PER_SHARD: 5,

  // Purchases — leader only, CAS-debited from the treasury.
  ROLES_UNLOCK: 15000, // -> rolesUnlocked = true, permanent
  XP_BOOST: 5000,      // -> xpBoostUntil = max(now, current) + 7 days
  MEMBER_SLOTS: 4000,  // -> purchasedSlots += SLOTS_PER_PURCHASE
  SLOTS_PER_PURCHASE: 5,
} as const;

/** The guild's cut of one member's xp gain. Canonical — src/lib/guildXp.ts
 *  should call this rather than restate the arithmetic. */
export const guildXpShare = (memberXp: number, boostActive: boolean): number => {
  const base = Math.max(0, Math.floor(Number(memberXp)) || 0) * GUILD_ECONOMY.MEMBER_XP_SHARE;
  return Math.floor(boostActive ? base * GUILD_ECONOMY.XP_BOOST_MULTIPLIER : base);
};

/** Treasury shards minted alongside a guild xp gain. Canonical, as above. */
export const treasuryFromXp = (guildXpGained: number): number =>
  Math.floor(Math.max(0, Math.floor(Number(guildXpGained)) || 0) / GUILD_ECONOMY.XP_PER_SHARD);

/** Is this guild's bought xp boost live right now? */
export const xpBoostActive = (until: Date | null | undefined, now: Date = new Date()): boolean =>
  !!until && until.getTime() > now.getTime();

// ── PRESENCE (there is no presence system on this site) ─────────────────────
// "Recently active" = User.updatedAt inside the last 10 minutes. Every earn,
// comment and profile action writes the user row, so it is a fair PROXY —
// it is never called "Online" anywhere, because the data does not support
// that claim.
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const isRecentlyActive = (updatedAt: Date | null | undefined, now: number): boolean =>
  !!updatedAt && now - updatedAt.getTime() <= ACTIVE_WINDOW_MS;

// ── USER level (for the minLevel join gate) ─────────────────────────────────
// NOT restated here. The site's user curve lives in ONE place —
// src/utils/economy.ts (userLevel / USER_MAX_LEVEL), mirrored by the
// frontend's src/lib/levels.ts — and this file imports it. A join gate that
// kept its own copy would let someone in (or bounce them) at a level the UI
// never showed them, which is exactly what the old duplicated max-10
// exponential formula did here.

// ── MIGRATION SAFETY: rolesUnlocked backfill ────────────────────────────────
// Custom roles shipped UNGATED, then became a 15,000-shard purchase. Any guild
// that already HAS roles must come out of this deploy unlocked — shipping a
// price tag must never regate a feature a guild is already using.
//
// One-shot at boot (this module is imported by the router, which app.ts
// mounts), idempotent, and one-directional: it only ever flips false -> true,
// on guilds that already own GuildRole rows. It can never fight a leader who
// unlocks normally afterwards, because unlocking IS this same direction and
// the flag is permanent. Failures are logged, never thrown — a backfill must
// not be able to take the API down.
let rolesUnlockBackfillStarted = false;

export async function backfillRolesUnlocked(): Promise<void> {
  if (rolesUnlockBackfillStarted) return;
  rolesUnlockBackfillStarted = true;
  try {
    const withRoles = await prisma.guildRole.findMany({
      select: { guildId: true },
      distinct: ["guildId"],
    });
    if (!withRoles.length) return;
    const done = await prisma.guild.updateMany({
      where: { id: { in: withRoles.map((r) => r.guildId) }, rolesUnlocked: false },
      data: { rolesUnlocked: true },
    });
    if (done.count > 0) {
      console.log(`Guild backfill: rolesUnlocked set on ${done.count} guild(s) that already had custom roles.`);
    }
  } catch (e) {
    console.error("Guild backfill (rolesUnlocked) failed — retry on next boot:", e);
  }
}

void backfillRolesUnlocked();

const NAME_MIN = 3;
const NAME_MAX = 24;
const TAG_RE = /^[A-Z]{2,5}$/;

// ── Guild imagery (avatar + banner + custom emoji) ──────────────────────────
// Same posture as the profileSong check in user.controller.ts: the URL loads
// in VISITORS' browsers, so the gate is https + a host allow-list — Cloudinary
// only, the CDN the rest of the product already serves art from. ONE checker
// for every guild-art field, so the avatar, banner and emoji rules can never
// drift apart — a second URL validator is exactly how one of them ends up
// accepting a host the others reject.
const GUILD_IMAGE_HOSTS = new Set(["res.cloudinary.com"]);

function checkGuildImage(
  raw: unknown,
  label: "avatar" | "banner" | "emoji"
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

// ── Join settings (shared by createGuild and updateGuild, so the two can
// never drift apart) ───────────────────────────────────────────────────────

/** Strict boolean — an absent field means "don't touch it", and a non-boolean
 *  is a client bug rather than something to coerce. */
function checkIsPublic(raw: unknown): { ok: true; value: boolean } | { ok: false; message: string } {
  if (typeof raw !== "boolean") return { ok: false, message: "isPublic must be true or false." };
  return { ok: true, value: raw };
}

/** 1..100 — the ceiling is USER_MAX_LEVEL, imported rather than typed out, so
 *  the bar a guild can set can never exceed the level a member can reach.
 *  (It read 1..10 while the user curve capped at 10; the curve now runs to
 *  100 and this follows it.) Clamped, not rejected. */
function checkMinLevel(raw: unknown): { ok: true; value: number } | { ok: false; message: string } {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) {
    return { ok: false, message: `minLevel must be a number from 1 to ${USER_MAX_LEVEL}.` };
  }
  return { ok: true, value: Math.max(1, Math.min(USER_MAX_LEVEL, n)) };
}

// ── POST /api/guilds ────────────────────────────────────────────────────────
// Found a guild: 2000 AP, name 3-24 chars, tag 2-5 uppercase letters, and an
// account at least 3 days old. The charge, the log, the guild and the leader
// membership are ONE transaction — a unique-violation on any of them rolls the
// AP straight back.

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

    // Join settings are optional at founding — omitted means the defaults
    // (public, level 1), the same values the column defaults carry.
    let isPublic = true;
    if (req.body?.isPublic !== undefined) {
      const check = checkIsPublic(req.body.isPublic);
      if (!check.ok) return res.status(400).json({ success: false, message: check.message });
      isPublic = check.value;
    }
    let minLevel = 1;
    if (req.body?.minLevel !== undefined) {
      const check = checkMinLevel(req.body.minLevel);
      if (!check.ok) return res.status(400).json({ success: false, message: check.message });
      minLevel = check.value;
    }

    // Account age is an anti-throwaway wall: founding is the one guild action
    // that mints a new group (and a new name/tag), so it is gated on the
    // account's OWN createdAt — a fact the account can't edit.
    const me = await prisma.user.findUnique({ where: { id: actor }, select: { createdAt: true } });
    if (!me) {
      return res.status(401).json({ success: false, message: "Sign in again to found a guild." });
    }
    const accountAgeMs = Date.now() - me.createdAt.getTime();
    if (accountAgeMs < GUILD_CREATE_MIN_ACCOUNT_DAYS * 86400000) {
      return res.status(403).json({
        success: false,
        message: `New accounts must wait ${GUILD_CREATE_MIN_ACCOUNT_DAYS} days before founding a guild.`,
      });
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
        data: { name, tag, description, leaderId: actor, isPublic, minLevel },
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
        shards: result.shards,
        ...levelBlock(result.xp, result.purchasedSlots),
        isPublic: result.isPublic, minLevel: result.minLevel,
        purchasedSlots: result.purchasedSlots,
        rolesUnlocked: result.rolesUnlocked,
        xpBoostUntil: result.xpBoostUntil,
        xpBoostActive: xpBoostActive(result.xpBoostUntil),
        memberCount: 1, createdAt: result.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/guilds ─────────────────────────────────────────────────────────
// The directory: ?search= &sort=level|members|xp|new &page= &perPage=.
//
// The response is { success, data, meta } where DATA IS STILL AN ARRAY — the
// rows — and every count lives in `meta`. This is a change to a deployed
// shape, and keeping data an array is what makes it a small one: a client
// that only maps over data keeps working.
//
// `sort=level` and `sort=xp` order identically ON PURPOSE: level is a pure
// function of xp, so ordering by one IS ordering by the other. Both keys
// exist so the UI can label the control however it likes.

const LIST_PER_PAGE_DEFAULT = 20;
const LIST_PER_PAGE_MAX = 50;
const SEARCH_MAX = 64;

export const listGuilds = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const search = String(req.query?.search ?? "").trim().slice(0, SEARCH_MAX);
    const sortRaw = String(req.query?.sort ?? "level");
    const sort = (["level", "members", "xp", "new"] as const).includes(sortRaw as never)
      ? (sortRaw as "level" | "members" | "xp" | "new")
      : "level";

    const page = Math.max(1, Math.floor(Number(req.query?.page)) || 1);
    const perPageRaw = Math.floor(Number(req.query?.perPage)) || LIST_PER_PAGE_DEFAULT;
    const perPage = Math.max(1, Math.min(LIST_PER_PAGE_MAX, perPageRaw));

    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { tag: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {};

    // members sorts on the relation count; the rest are plain columns. The
    // createdAt tiebreak keeps paging stable when two guilds tie.
    const orderBy =
      sort === "members"
        ? ([{ members: { _count: "desc" } }, { createdAt: "asc" }] as const)
        : sort === "new"
        ? ([{ createdAt: "desc" }] as const)
        : ([{ xp: "desc" }, { createdAt: "asc" }] as const);

    const [total, guilds, totalGuilds, top] = await Promise.all([
      prisma.guild.count({ where }),
      prisma.guild.findMany({
        where,
        include: { _count: { select: { members: true } } },
        orderBy: [...orderBy],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      // Directory-wide, deliberately UNFILTERED: the header stat shouldn't
      // jump around while someone types in the search box.
      prisma.guild.count(),
      prisma.guild.findFirst({ orderBy: { xp: "desc" }, select: { xp: true } }),
    ]);

    const rows = guilds.map((g) => ({
      id: g.id, name: g.name, tag: g.tag, description: g.description,
      avatar: g.avatar, banner: g.banner,
      leaderId: g.leaderId, coLeaderId: g.coLeaderId,
      shards: g.shards, xp: g.xp,
      level: guildLevel(g.xp),
      memberCount: g._count.members,
      memberCap: memberCap(guildLevel(g.xp), g.purchasedSlots),
      isPublic: g.isPublic, minLevel: g.minLevel,
      createdAt: g.createdAt,
    }));

    res.json({
      success: true,
      data: rows,
      meta: {
        total,          // guilds matching the search
        page,
        perPage,
        totalGuilds,    // guilds in the whole directory, unfiltered
        // members across the rows ON THIS PAGE — literally what's shown.
        membersShown: rows.reduce((n, r) => n + r.memberCount, 0),
        // the top level in the whole directory, unfiltered (see totalGuilds).
        highestLevel: guildLevel(top?.xp ?? 0),
      },
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

  // ONE batched lookup for every member's name, avatar AND updatedAt — the
  // presence proxy rides along on the query that was already happening, never
  // a per-member round trip.
  const users = guild.members.length
    ? await prisma.user.findMany({
        where: { id: { in: guild.members.map((m) => m.userId) } },
        select: { id: true, username: true, avatar: true, updatedAt: true },
      })
    : [];
  const byUser = new Map(users.map((u) => [u.id, u]));

  const myMembership = actor ? guild.members.find((m) => m.userId === actor) || null : null;
  const roles = await prisma.guildRole.findMany({
    where: { guildId: id },
    orderBy: { createdAt: "asc" },
  });
  const now = new Date();
  const activeLoanCount = await prisma.guildCardLoan.count({
    where: { guildId: id, expiresAt: { gt: now } },
  });
  // Capacity only — a COUNT, never the rows. The emoji CATALOG (names + urls)
  // is members-only and lives on GET /:id/emojis; this payload is a PUBLIC
  // read, so it carries the number the guild page needs to draw "7 / 15" and
  // nothing a non-member shouldn't see.
  const emojiUsed = await prisma.guildEmoji.count({ where: { guildId: id } });

  const nowMs = now.getTime();
  const members = guild.members.map((m) => {
    const u = byUser.get(m.userId);
    return {
      userId: m.userId,
      username: u?.username || "?",
      avatar: u?.avatar || null,
      role: m.role,
      customRoleId: m.customRoleId,
      xpContributed: m.xpContributed,
      // "Active"/"Recently active" — NEVER "Online". See ACTIVE_WINDOW_MS.
      activeRecently: isRecentlyActive(u?.updatedAt, nowMs),
      joinedAt: m.joinedAt,
    };
  });

  const memberCount = members.length;
  const activeCount = members.filter((m) => m.activeRecently).length;
  // Highest contributor, or null when nobody has fed the guild yet — a "top
  // contributor" sitting on 0 would be a podium for doing nothing.
  const best = members.reduce<(typeof members)[number] | null>(
    (top, m) => (m.xpContributed > (top?.xpContributed ?? 0) ? m : top),
    null
  );

  return {
    id: guild.id, name: guild.name, tag: guild.tag,
    description: guild.description, avatar: guild.avatar, banner: guild.banner,
    leaderId: guild.leaderId, coLeaderId: guild.coLeaderId,
    shards: guild.shards,
    // level, xp, xpIntoLevel, xpForNextLevel, progressPct, maxLevel, isMax,
    // memberCap — the one progression shape, computed server-side only.
    ...levelBlock(guild.xp, guild.purchasedSlots),
    isPublic: guild.isPublic,
    minLevel: guild.minLevel,
    purchasedSlots: guild.purchasedSlots,
    rolesUnlocked: guild.rolesUnlocked,
    xpBoostUntil: guild.xpBoostUntil,
    xpBoostActive: xpBoostActive(guild.xpBoostUntil, now),
    createdAt: guild.createdAt,
    memberCount,
    stats: {
      memberCount,
      activeCount,
      onlineRate: memberCount ? Math.round((activeCount / memberCount) * 100) : 0,
      avgXp: Math.round(guild.xp / Math.max(1, memberCount)),
      topContributor: best
        ? { userId: best.userId, username: best.username, avatar: best.avatar, xpContributed: best.xpContributed }
        : null,
    },
    // Capacity WITHOUT the catalog, so the guild page can draw the meter
    // without a second call — and without leaking a members-only list into a
    // public read. total is a pure function of level (see emojiSlots).
    emojiSlots: { used: emojiUsed, total: emojiSlots(guildLevel(guild.xp)) },
    roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.color, permissions: r.permissions })),
    members,
    myMembership: myMembership
      ? {
          role: myMembership.role,
          customRoleId: myMembership.customRoleId,
          xpContributed: myMembership.xpContributed,
          joinedAt: myMembership.joinedAt,
        }
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
        level: guildLevel(guild.xp),
        memberCap: memberCap(guildLevel(guild.xp), guild.purchasedSlots),
        xp: guild.xp,
        shards: guild.shards,
        memberCount: guild._count.members,
        role,
        xpContributed: membership.xpContributed,
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

// ── Admission ───────────────────────────────────────────────────────────────
// THE one gate into a guild, shared by POST /:id/join and invite-accept so the
// two can never enforce different rules. Everything happens inside ONE
// transaction under a guild-row lock:
//
//   · the cap is re-checked under the lock — N parallel joins would all pass a
//     plain count, and the cap is a wall, not a suggestion
//   · minLevel is checked against the joiner's OWN xp, read in the same tx
//   · a private guild REQUIRES a pending invite, and the invite is consumed
//     (deleted) in the same transaction as the membership — so it can never be
//     spent twice, and a later failure rolls the consumption back with it
//   · the GuildMember.userId unique constraint independently stops a
//     double-join, whatever the counts say
//
// A public join ALSO clears any pending invite for that user: once they're in,
// the invite is noise.

type Admission =
  | { ok: true; guildId: string; guildName: string; role: string; joinedAt: Date }
  | { ok: false; status: number; message: string };

const admissionError = (status: number, message: string) =>
  Object.assign(new Error("guild-admission"), { guildStatus: status, guildMessage: message });

async function admitMember(guildId: string, actorId: string, viaInvite: boolean): Promise<Admission> {
  return prisma
    .$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Guild" WHERE id = ${guildId} FOR UPDATE`;
      const guild = await tx.guild.findUnique({ where: { id: guildId } });
      if (!guild) throw admissionError(404, "Guild not found.");

      const user = await tx.user.findUnique({ where: { id: actorId }, select: { xp: true } });
      if (!user) throw admissionError(401, "Sign in again to join a guild.");

      // The invite gate first: on a private guild it is the identity check,
      // and the delete IS the consumption.
      const consumed = await tx.guildInvite.deleteMany({ where: { guildId, userId: actorId } });
      if (viaInvite && consumed.count === 0) {
        throw admissionError(404, "That invite is no longer valid.");
      }
      if (!guild.isPublic && consumed.count === 0) {
        throw admissionError(403, "This guild is invite-only.");
      }

      const level = userLevel(user.xp);
      if (level < guild.minLevel) {
        throw admissionError(
          403,
          `${guild.name} only accepts level ${guild.minLevel} and above — you're level ${level}.`
        );
      }

      const cap = memberCap(guildLevel(guild.xp), guild.purchasedSlots);
      const count = await tx.guildMember.count({ where: { guildId } });
      if (count >= cap) {
        throw admissionError(409, `${guild.name} is full (${cap} members).`);
      }

      const member = await tx.guildMember.create({ data: { guildId, userId: actorId } });
      return {
        ok: true as const,
        guildId,
        guildName: guild.name,
        role: member.role,
        joinedAt: member.joinedAt,
      };
    })
    .catch((e: any): Admission => {
      if (typeof e?.guildStatus === "number") {
        return { ok: false, status: e.guildStatus, message: String(e.guildMessage) };
      }
      // GuildMember.userId is unique — one guild per user, enforced by the DB.
      if (e?.code === "P2002") {
        return { ok: false, status: 409, message: "You're already in a guild — leave it first." };
      }
      throw e;
    });
}

// ── POST /api/guilds/:id/join ───────────────────────────────────────────────

export const joinGuild = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to join a guild." });
    }
    const id = req.params.id as string;

    // Fast-path courtesy; the unique constraint inside admitMember is the wall.
    const existing = await prisma.guildMember.findUnique({ where: { userId: actor } });
    if (existing) {
      return res.status(409).json({ success: false, message: "You're already in a guild — leave it first." });
    }

    const admitted = await admitMember(id, actor, false);
    if (!admitted.ok) {
      return res.status(admitted.status).json({ success: false, message: admitted.message });
    }

    res.json({ success: true, data: { guildId: id, role: admitted.role, joinedAt: admitted.joinedAt } });
  } catch (error) {
    next(error);
  }
};

// ── Disband ─────────────────────────────────────────────────────────────────
// Turning off the lights, in the order the constraints require. GuildMember is
// the ONLY table with an FK to Guild, so its rows cascade with the delete;
// roles, invites, loans and messages carry a plain guildId (the duel pattern)
// and would otherwise outlive the guild as unreachable rows.
//
// Returned as an ops ARRAY so both callers run it as one $transaction —
// nothing half-swept.
//
// Guild BOARD POSTS (Comment.guildId) are deliberately NOT deleted: they are
// member-authored content with votes, replies, reports and polls hanging off
// them, and every feed already excludes guild-stamped comments, so they go
// quiet rather than dangling. Hard-deleting other people's writing is not
// something a disband should do silently.
const disbandOps = (guildId: string) => [
  prisma.guildCardLoan.deleteMany({ where: { guildId } }),
  prisma.guildRole.deleteMany({ where: { guildId } }),
  prisma.guildInvite.deleteMany({ where: { guildId } }),
  prisma.guildMessage.deleteMany({ where: { guildId } }),
  // Custom emoji carry a plain guildId like roles and invites, so they need an
  // explicit sweep — a disbanded guild's emoji would otherwise sit forever as
  // unreachable rows still holding the @@unique([guildId, name]) pairs.
  prisma.guildEmoji.deleteMany({ where: { guildId } }),
  prisma.guild.delete({ where: { id: guildId } }), // cascades GuildMember
];

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
      // Last member out turns off the lights — the same sweep the leader's
      // explicit disband runs, so the two paths can't clean different things.
      await prisma.$transaction(disbandOps(guildId));
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

/** Custom roles are a 15,000-shard TREASURY PURCHASE. Role management is
 *  gated on the guild having bought them; ASSIGNING an existing role is not,
 *  so a guild is never locked out of the roles it already owns.
 *
 *  Any guild that already had roles when this shipped was backfilled to
 *  unlocked (see backfillRolesUnlocked), so this gate can never strand an
 *  existing role — and the flag is permanent, never revoked. */
function rolesLocked(guild: { rolesUnlocked: boolean }) {
  return !guild.rolesUnlocked;
}

const ROLES_LOCKED_MESSAGE = "Custom roles aren't unlocked yet.";

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
    if (rolesLocked(guild)) {
      return res.status(402).json({ success: false, message: ROLES_LOCKED_MESSAGE });
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

    if (rolesLocked(guild)) {
      return res.status(402).json({ success: false, message: ROLES_LOCKED_MESSAGE });
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
//
// Deliberately NOT gated on rolesUnlocked, unlike create/update: removing a
// role is cleanup and a safety valve (a role that grants kickMembers must
// always be revocable), and paywalling the way OUT of a permission is the one
// thing this gate must never do.

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

// ═══ CUSTOM EMOJI ═══════════════════════════════════════════════════════════
// Discord-style :shortcode: emoji, per guild, used in GUILD CHAT — a
// members-only room. That is why the CATALOG read is members-only too: an
// outsider has nowhere to type them, and the list is the guild's own art.
// These are NOT global site emoji and are never resolved outside their guild.
//
// STORAGE: the image goes to Cloudinary through the same unsigned-preset
// upload the crest and banner already use; only the returned secure_url
// reaches us, and it is host-walled by checkGuildImage — the SAME checker, not
// a copy. The url renders in every member's browser, so an arbitrary host is
// never stored.
//
// CAPACITY is a LEVEL REWARD — emojiSlots(guildLevel(xp)), no purchase and no
// new currency. Like ROLE_CAP (and unlike the member cap, which is a wall
// under a row lock) the check is a plain count: two racing uploads could
// overshoot by one, which costs one extra emoji and nothing of value.
//
// WRITES are editGuild — officers, plus any custom role granted editGuild —
// resolved through actorPermsFor, the same call updateGuild uses. Guild art is
// guild art; there is no separate emoji power to get out of sync.

const EMOJI_NAME_RE = /^[a-z0-9_]{2,24}$/;
const EMOJI_URL_MAX = 400; // a Cloudinary secure_url is ~100; this is the ceiling, not a target

/** Lowercased and trimmed BEFORE the test, so `:Sparkle:` is stored as
 *  `sparkle` rather than rejected — the shortcode is case-insensitive by
 *  construction, which is also what makes @@unique([guildId, name]) mean
 *  "one :sparkle: per guild" instead of one per capitalisation. */
function checkEmojiName(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "Emoji names are text, typed as :name:." };
  const name = raw.trim().toLowerCase();
  if (!EMOJI_NAME_RE.test(name)) {
    return {
      ok: false,
      message: "Emoji names are 2-24 characters — lowercase letters, numbers and underscores only, typed as :name:.",
    };
  }
  return { ok: true, value: name };
}

/** The wire shape for one emoji, in ONE place: the catalog and the create
 *  response answer with the same object, and NEITHER exposes createdAt or
 *  createdBy — the chat picker needs the name, the image and whether to play
 *  it, nothing else. */
const shapeEmoji = (e: { id: string; name: string; url: string; animated: boolean }) => ({
  id: e.id,
  name: e.name,
  url: e.url,
  animated: e.animated,
});

/** used/total for one guild, from the level curve. total is derived, never
 *  stored, so a guild that levels up gains the slot the same instant. */
async function emojiCapacity(guildId: string, xp: number) {
  const used = await prisma.guildEmoji.count({ where: { guildId } });
  return { used, total: emojiSlots(guildLevel(xp)) };
}

// ── GET /api/guilds/:id/emojis ──────────────────────────────────────────────
// MEMBERS ONLY, both walls: a verified JWT and current membership of THIS
// guild, re-resolved per request like guild chat — leaving or being kicked
// closes the catalog on the very next call. A member of ANOTHER guild is 403,
// not 404: the guild exists, this room just isn't theirs.

export const listEmojis = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to see this guild's emoji." });
    }
    const id = req.params.id as string;

    const guild = await prisma.guild.findUnique({ where: { id }, select: { id: true, xp: true } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });

    // GuildMember.userId is unique, so ONE lookup answers both "in a guild"
    // and "in this one".
    const membership = await prisma.guildMember.findUnique({ where: { userId: actor } });
    if (!membership || membership.guildId !== id) {
      return res.status(403).json({ success: false, message: "Guild emoji are members-only." });
    }

    const [emojis, slots] = await Promise.all([
      prisma.guildEmoji.findMany({ where: { guildId: id }, orderBy: { name: "asc" } }),
      emojiCapacity(id, guild.xp),
    ]);

    res.json({ success: true, data: { emojis: emojis.map(shapeEmoji), slots } });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/:id/emojis ─────────────────────────────────────────────
// editGuild — officers, or a custom role granted it (actorPermsFor, the same
// resolution updateGuild uses; a non-member's flags all read false, so this
// gate is also the membership check).

export const createEmoji = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    const perms = await actorPermsFor(guild, actor);
    if (!perms.editGuild) {
      return res.status(403).json({ success: false, message: "You don't have permission to manage this guild's emoji." });
    }

    const name = checkEmojiName(req.body?.name);
    if (!name.ok) return res.status(400).json({ success: false, message: name.message });

    // Length FIRST — checkGuildImage runs `new URL()`, and there is no reason
    // to parse an unbounded string before capping it.
    const rawUrl = typeof req.body?.url === "string" ? req.body.url.trim() : req.body?.url;
    if (typeof rawUrl === "string" && rawUrl.length > EMOJI_URL_MAX) {
      return res.status(400).json({ success: false, message: "That image link is too long." });
    }
    // The SAME host wall the crest and banner use.
    const url = checkGuildImage(rawUrl, "emoji");
    if (!url.ok) return res.status(400).json({ success: false, message: url.message });
    // checkGuildImage treats empty/null as "clear the field", which is a real
    // answer for an avatar and a nonsense one here: an emoji IS its image.
    if (!url.value) {
      return res.status(400).json({ success: false, message: "Upload an image for the emoji first." });
    }

    // Strict `=== true`, the grantsOf posture: a client hint about whether to
    // render a still frame. Nothing on the server behaves differently.
    const animated = req.body?.animated === true;

    // Plain count (see the ROLE_CAP note): the cap is a ceiling, not the
    // member wall. The numbers ride along on the refusal so the UI can say
    // "12 / 12 — level up for more" without a second call.
    const slots = await emojiCapacity(id, guild.xp);
    if (slots.used >= slots.total) {
      return res.status(409).json({
        success: false,
        message: `This guild's emoji slots are full (${slots.used}/${slots.total}). Guild levels unlock more — one every 5 levels, up to ${EMOJI_SLOTS_MAX}.`,
        slots,
      });
    }

    // Pre-check for the good message; the @@unique([guildId, name]) violation
    // below is what actually holds under a race.
    const clash = await prisma.guildEmoji.findFirst({
      where: { guildId: id, name: name.value },
      select: { id: true },
    });
    if (clash) {
      return res.status(409).json({ success: false, message: `:${name.value}: already exists in this guild.` });
    }

    const created = await prisma.guildEmoji
      .create({ data: { guildId: id, name: name.value, url: url.value, animated, createdBy: actor } })
      .catch((e) => {
        if (e?.code === "P2002") return null; // @@unique([guildId, name])
        throw e;
      });
    if (!created) {
      return res.status(409).json({ success: false, message: `:${name.value}: already exists in this guild.` });
    }

    // Re-counted rather than used + 1: under a race the increment would be a
    // guess, and this number is what the meter draws.
    const after = await emojiCapacity(id, guild.xp);
    return res.status(201).json({ success: true, data: { emoji: shapeEmoji(created), slots: after } });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/guilds/:id/emojis/:emojiId ──────────────────────────────────
// Same gate as create. The delete keeps the guildId condition on the
// destructive half — an emoji id from ANOTHER guild matches zero rows and
// answers 404, so this can never reach across a guild wall — and a
// double-click's second request 404s instead of throwing P2025.

export const deleteEmoji = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;
    const emojiId = req.params.emojiId as string;

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    const perms = await actorPermsFor(guild, actor);
    if (!perms.editGuild) {
      return res.status(403).json({ success: false, message: "You don't have permission to manage this guild's emoji." });
    }

    const gone = await prisma.guildEmoji.deleteMany({ where: { id: emojiId, guildId: id } });
    if (gone.count === 0) {
      return res.status(404).json({ success: false, message: "Emoji not found." });
    }

    const slots = await emojiCapacity(id, guild.xp);
    res.json({ success: true, data: { deleted: emojiId, slots } });
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

    const data: {
      description?: string;
      avatar?: string | null;
      banner?: string | null;
      isPublic?: boolean;
      minLevel?: number;
    } = {};
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
    // Join settings ride the SAME gate as the profile fields — deciding who
    // may walk in is guild-profile editing, not a leadership-only power.
    // Changing them never touches anyone already inside: an existing member
    // below a raised minLevel keeps their seat.
    if (req.body?.isPublic !== undefined) {
      const check = checkIsPublic(req.body.isPublic);
      if (!check.ok) return res.status(400).json({ success: false, message: check.message });
      data.isPublic = check.value;
    }
    if (req.body?.minLevel !== undefined) {
      const check = checkMinLevel(req.body.minLevel);
      if (!check.ok) return res.status(400).json({ success: false, message: check.message });
      data.minLevel = check.value;
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update." });
    }

    const updated = await prisma.guild.update({ where: { id }, data });
    res.json({
      success: true,
      data: {
        description: updated.description,
        avatar: updated.avatar,
        banner: updated.banner,
        isPublic: updated.isPublic,
        minLevel: updated.minLevel,
      },
    });
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

// ═══ INVITES ════════════════════════════════════════════════════════════════
// A private guild can only be joined with a pending invite, so these ARE the
// door. Sending, listing and revoking are OFFICER-only (the persistent
// leaderId/coLeaderId columns, never a custom grant — a role that could invite
// could stuff a guild); accepting and declining belong to the INVITEE alone.
//
// The invite is consumed inside admitMember's transaction, so it can never be
// spent twice, and every accept re-runs the full cap/level gate: an invite is
// permission to knock, not a key that bypasses the rules.

const INVITE_CAP = 50; // pending invites per guild

// ── POST /api/guilds/:id/invites ────────────────────────────────────────────

export const inviteMember = async (req: Request, res: Response, next: NextFunction) => {
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
    const perms = await actorPermsFor(guild, actor);
    if (!perms.officer) {
      return res.status(403).json({ success: false, message: "Only the guild leader or co-leader can send invites." });
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, username: true, avatar: true },
    });
    if (!target) {
      return res.status(404).json({ success: false, message: "That user doesn't exist." });
    }

    // One guild per user is the whole design, so an invite to someone who
    // already has a guild could never be accepted — reject it here rather than
    // parking a dead invite in their inbox.
    const membership = await prisma.guildMember.findUnique({ where: { userId: targetId } });
    if (membership) {
      return res.status(409).json({
        success: false,
        message: membership.guildId === id
          ? `${target.username} is already in your guild.`
          : `${target.username} is already in another guild — they'd have to leave it first.`,
      });
    }

    // Plain count, like ROLE_CAP — a race overshooting by one is accepted; the
    // cap is a spam ceiling, not a wall like the member cap.
    const pending = await prisma.guildInvite.count({ where: { guildId: id } });
    if (pending >= INVITE_CAP) {
      return res.status(409).json({
        success: false,
        message: `You already have ${INVITE_CAP} invites pending — revoke one first.`,
      });
    }

    const invite = await prisma.guildInvite
      .create({ data: { guildId: id, userId: targetId, invitedBy: actor } })
      .catch((e) => {
        if (e?.code === "P2002") return null; // @@unique([guildId, userId])
        throw e;
      });
    if (!invite) {
      return res.status(409).json({ success: false, message: `${target.username} has already been invited.` });
    }

    return res.status(201).json({
      success: true,
      data: {
        id: invite.id,
        guildId: invite.guildId,
        userId: invite.userId,
        username: target.username,
        avatar: target.avatar,
        invitedBy: invite.invitedBy,
        createdAt: invite.createdAt,
        pending: pending + 1,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/guilds/:id/invites ─────────────────────────────────────────────
// Officer-only: who is currently invited. ONE batched user lookup covers both
// the invitees and the officers who sent them.

export const listInvites = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    const perms = await actorPermsFor(guild, actor);
    if (!perms.officer) {
      return res.status(403).json({ success: false, message: "Only the guild leader or co-leader can see invites." });
    }

    const invites = await prisma.guildInvite.findMany({
      where: { guildId: id },
      orderBy: { createdAt: "desc" },
    });
    const ids = Array.from(new Set(invites.flatMap((i) => [i.userId, i.invitedBy])));
    const users = ids.length
      ? await prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, username: true, avatar: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    res.json({
      success: true,
      data: invites.map((i) => ({
        id: i.id,
        userId: i.userId,
        username: byId.get(i.userId)?.username || "?",
        avatar: byId.get(i.userId)?.avatar || null,
        invitedBy: i.invitedBy,
        invitedByName: byId.get(i.invitedBy)?.username || "?",
        createdAt: i.createdAt,
      })),
      meta: { total: invites.length, cap: INVITE_CAP },
    });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/guilds/:id/invites/:inviteId ────────────────────────────────

export const revokeInvite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;
    const inviteId = req.params.inviteId as string;

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    const perms = await actorPermsFor(guild, actor);
    if (!perms.officer) {
      return res.status(403).json({ success: false, message: "Only the guild leader or co-leader can revoke invites." });
    }

    // id AND guildId — an invite id from another guild is a 404, not a handle.
    const gone = await prisma.guildInvite.deleteMany({ where: { id: inviteId, guildId: id } });
    if (gone.count === 0) {
      return res.status(404).json({ success: false, message: "Invite not found." });
    }
    res.json({ success: true, data: { revoked: inviteId } });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/guilds/mine/invites ────────────────────────────────────────────
// MY pending invites. Invites carry a plain guildId (no FK), so an invite
// whose guild disbanded is simply dropped from the answer rather than
// rendering as a broken row.

export const myInvites = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to see your invites." });
    }

    const invites = await prisma.guildInvite.findMany({
      where: { userId: actor },
      orderBy: { createdAt: "desc" },
    });
    if (!invites.length) return res.json({ success: true, data: [] });

    const guilds = await prisma.guild.findMany({
      where: { id: { in: Array.from(new Set(invites.map((i) => i.guildId))) } },
      include: { _count: { select: { members: true } } },
    });
    const byId = new Map(guilds.map((g) => [g.id, g]));

    res.json({
      success: true,
      data: invites.flatMap((i) => {
        const g = byId.get(i.guildId);
        if (!g) return [];
        const level = guildLevel(g.xp);
        return [{
          id: i.id,
          guildId: g.id,
          name: g.name,
          tag: g.tag,
          avatar: g.avatar,
          level,
          memberCount: g._count.members,
          memberCap: memberCap(level, g.purchasedSlots),
          isPublic: g.isPublic,
          minLevel: g.minLevel,
          invitedBy: i.invitedBy,
          createdAt: i.createdAt,
        }];
      }),
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/invites/:inviteId/accept ───────────────────────────────
// The INVITEE only. Runs the exact same cap/level gate as a public join —
// admitMember is the one door — and consumes the invite in that transaction.

export const acceptInvite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const inviteId = req.params.inviteId as string;

    const invite = await prisma.guildInvite.findUnique({ where: { id: inviteId } });
    if (!invite) return res.status(404).json({ success: false, message: "Invite not found." });
    if (invite.userId !== actor) {
      return res.status(403).json({ success: false, message: "That invite isn't yours." });
    }

    const existing = await prisma.guildMember.findUnique({ where: { userId: actor } });
    if (existing) {
      return res.status(409).json({ success: false, message: "You're already in a guild — leave it first." });
    }

    const admitted = await admitMember(invite.guildId, actor, true);
    if (!admitted.ok) {
      return res.status(admitted.status).json({ success: false, message: admitted.message });
    }
    res.json({
      success: true,
      data: { guildId: admitted.guildId, name: admitted.guildName, role: admitted.role, joinedAt: admitted.joinedAt },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/invites/:inviteId/decline ──────────────────────────────

export const declineInvite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const inviteId = req.params.inviteId as string;

    // id AND userId — declining is only ever your OWN invite, and a miss is a
    // 404 either way, so this never confirms someone else's invite exists.
    const gone = await prisma.guildInvite.deleteMany({ where: { id: inviteId, userId: actor } });
    if (gone.count === 0) {
      return res.status(404).json({ success: false, message: "Invite not found." });
    }
    res.json({ success: true, data: { declined: inviteId } });
  } catch (error) {
    next(error);
  }
};

// ═══ TREASURY ═══════════════════════════════════════════════════════════════
// CLOSED LOOP. Shards come IN (raid kills, the guild's cut of member xp, and
// donations here) and are only ever SPENT on the purchases below. There is no
// endpoint, anywhere, that pays treasury shards back into a personal balance —
// donating is a one-way door and the UI must say so.

const DONATE_MAX = 1_000_000; // one transfer; not a lifetime cap

// ── POST /api/guilds/:id/donate ─────────────────────────────────────────────

export const donateShards = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to donate." });
    }
    const id = req.params.id as string;

    // A POSITIVE INTEGER, not a coerced float: 5.9 shards is a client bug, and
    // silently donating 5 would be answering a question nobody asked.
    const amount = Number(req.body?.shards);
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "Donate a positive whole number of shards." });
    }
    if (amount > DONATE_MAX) {
      return res.status(400).json({ success: false, message: `You can donate at most ${DONATE_MAX.toLocaleString()} shards at once.` });
    }

    const membership = await prisma.guildMember.findUnique({ where: { userId: actor } });
    if (!membership || membership.guildId !== id) {
      return res.status(403).json({ success: false, message: "You're not a member of this guild." });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Conditional decrement — the founding/Rally pattern. An insufficient
      // balance matches zero rows and the whole donation rolls back, so a
      // personal balance can never go negative.
      const paid = await tx.user.updateMany({
        where: { id: actor, shards: { gte: amount } },
        data: { shards: { decrement: amount } },
      });
      if (paid.count === 0) {
        throw Object.assign(new Error("donate-poor"), { guildCode: 402 });
      }
      // updateMany, not update: a guild disbanded mid-flight matches zero rows
      // and we roll the debit back instead of burning the member's shards.
      const credited = await tx.guild.updateMany({
        where: { id },
        data: { shards: { increment: amount } },
      });
      if (credited.count === 0) {
        throw Object.assign(new Error("donate-gone"), { guildCode: 404 });
      }
      // Ledger trail. amount is 0 ON PURPOSE: PointLog is the ARISE POINTS
      // ledger (it feeds the daily earning cap and the console's credit/debit
      // filters), and this moved SHARDS. Logging -amount here would lie about
      // a currency that never left. The reason string carries the real number,
      // the same way the free-staff-pull rows do.
      await tx.pointLog.create({
        data: { userId: actor, amount: 0, reason: `guild-donate:${id}:${amount}` },
      });
      const [me, guild] = await Promise.all([
        tx.user.findUnique({ where: { id: actor }, select: { shards: true } }),
        tx.guild.findUnique({ where: { id }, select: { shards: true } }),
      ]);
      return { shards: me?.shards ?? 0, treasury: guild?.shards ?? 0 };
    }).catch((e) => {
      if (e?.guildCode === 402) return "poor" as const;
      if (e?.guildCode === 404) return "gone" as const;
      throw e;
    });

    if (result === "poor") {
      return res.status(402).json({ success: false, message: "You don't have that many shards." });
    }
    if (result === "gone") {
      return res.status(404).json({ success: false, message: "Guild not found." });
    }

    res.json({
      success: true,
      data: { donated: amount, shards: result.shards, treasury: result.treasury },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/guilds/:id/purchase ───────────────────────────────────────────
// LEADER only — spending the treasury is the one power the deputy doesn't
// share. Every branch takes the guild row lock, then CAS-debits the treasury
// (`shards: { gte: cost }`), so a double-click can never overdraw it and the
// balance can never go negative. Nothing here ever pays shards OUT to a person.

type PurchaseItem = "roles" | "xpBoost" | "slots";

export const purchaseUpgrade = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;
    const item = String(req.body?.item || "") as PurchaseItem;
    if (!["roles", "xpBoost", "slots"].includes(item)) {
      return res.status(400).json({ success: false, message: "Unknown purchase." });
    }

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    if (guild.leaderId !== actor) {
      return res.status(403).json({ success: false, message: "Only the guild leader can spend the treasury." });
    }

    const cost =
      item === "roles" ? GUILD_ECONOMY.ROLES_UNLOCK :
      item === "xpBoost" ? GUILD_ECONOMY.XP_BOOST :
      GUILD_ECONOMY.MEMBER_SLOTS;

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Guild" WHERE id = ${id} FOR UPDATE`;
      const fresh = await tx.guild.findUnique({ where: { id } });
      if (!fresh) throw Object.assign(new Error("buy-gone"), { guildCode: 404 });

      // The 409s come FIRST, so a purchase that would change nothing is
      // refused rather than taking the shards.
      if (item === "roles" && fresh.rolesUnlocked) {
        throw Object.assign(new Error("buy-owned"), { guildCode: 409, guildWhy: "Custom roles are already unlocked." });
      }
      if (item === "slots" && memberCap(guildLevel(fresh.xp), fresh.purchasedSlots) >= GUILD_HARD_MEMBER_CAP) {
        throw Object.assign(new Error("buy-capped"), {
          guildCode: 409,
          guildWhy: `This guild is already at the ${GUILD_HARD_MEMBER_CAP}-member ceiling — extra slots would do nothing.`,
        });
      }

      // CAS debit. Under the row lock this can't lose a race, and the
      // `gte` guard means it can never write a negative treasury even if the
      // lock were ever dropped. Treasury shards LEAVE here and are not
      // credited to anyone — spending is a burn, not a transfer.
      const paid = await tx.guild.updateMany({
        where: { id, shards: { gte: cost } },
        data: { shards: { decrement: cost } },
      });
      if (paid.count === 0) {
        throw Object.assign(new Error("buy-poor"), { guildCode: 402, guildHave: fresh.shards });
      }

      if (item === "roles") {
        await tx.guild.update({ where: { id }, data: { rolesUnlocked: true } });
      } else if (item === "slots") {
        await tx.guild.update({
          where: { id },
          data: { purchasedSlots: { increment: GUILD_ECONOMY.SLOTS_PER_PURCHASE } },
        });
      } else {
        // Buying while a boost is live EXTENDS it: from the later of now and
        // the current expiry, never from now (which would shorten it).
        const now = new Date();
        const from = fresh.xpBoostUntil && fresh.xpBoostUntil > now ? fresh.xpBoostUntil : now;
        await tx.guild.update({
          where: { id },
          data: { xpBoostUntil: new Date(from.getTime() + GUILD_ECONOMY.XP_BOOST_DAYS * 86400000) },
        });
      }

      const after = await tx.guild.findUnique({ where: { id } });
      return {
        treasury: after?.shards ?? 0,
        rolesUnlocked: after?.rolesUnlocked ?? false,
        purchasedSlots: after?.purchasedSlots ?? 0,
        xpBoostUntil: after?.xpBoostUntil ?? null,
      };
    }).catch((e) => {
      if (e?.guildCode === 404) return "gone" as const;
      if (e?.guildCode === 409) return { conflict: String(e.guildWhy) } as const;
      if (e?.guildCode === 402) return { poor: Number(e.guildHave) || 0 } as const;
      throw e;
    });

    if (result === "gone") {
      return res.status(404).json({ success: false, message: "Guild not found." });
    }
    if ("conflict" in result) {
      return res.status(409).json({ success: false, message: result.conflict });
    }
    if ("poor" in result) {
      return res.status(402).json({
        success: false,
        message: `That costs ${cost.toLocaleString()} shards and the treasury holds ${result.poor.toLocaleString()}.`,
      });
    }

    const data = await guildDetailPayload(id, actor);
    if (!data) return res.status(404).json({ success: false, message: "Guild not found." });
    res.json({
      success: true,
      data: {
        ...data,
        purchase: {
          item,
          cost,
          treasury: result.treasury,
          rolesUnlocked: result.rolesUnlocked,
          purchasedSlots: result.purchasedSlots,
          xpBoostUntil: result.xpBoostUntil,
          xpBoostActive: xpBoostActive(result.xpBoostUntil),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/guilds/:id ──────────────────────────────────────────────────
// LEADER only. One transaction, the same sweep the last-member leave runs —
// see disbandOps for what cascades and what has to be cleaned by hand. The
// treasury dies with the guild: closed loop, nothing pays out.

export const disbandGuild = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to do that." });
    }
    const id = req.params.id as string;

    const guild = await prisma.guild.findUnique({ where: { id } });
    if (!guild) return res.status(404).json({ success: false, message: "Guild not found." });
    if (guild.leaderId !== actor) {
      return res.status(403).json({ success: false, message: "Only the guild leader can disband the guild." });
    }

    const done = await prisma.$transaction(disbandOps(id)).catch((e) => {
      if (e?.code === "P2025") return null; // already gone mid-flight
      throw e;
    });
    if (!done) return res.status(404).json({ success: false, message: "Guild not found." });

    res.json({ success: true, data: { disbanded: id, name: guild.name } });
  } catch (error) {
    next(error);
  }
};
