import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { requireStaff } from "../lib/staff";
import { weekKey } from "./gem.controller";
import { CARDS, levelMult, FORGE_ATK_STEP, FORGE_HP_STEP } from "../data/cardCatalog";
import { CARD_STATS_BY_ID, CARD_STATS } from "../data/duelRules";
import {
  RAID, bossForWeek, bossBySlug,
  gimmickDamageMult, gimmickAffinityMult, gimmickVarietyMult,
  gimmickInjuryMult, gimmickHpMult, gimmickRewardMult,
} from "../data/raidBosses";

/**
 * GUILD RAID BOSS.
 *
 * One boss per ISO week; every guild fights ITS OWN encounter against it,
 * and guildless players share the realm-wide one (guildId sentinel "realm").
 * The encounter key is derived SERVER-side from the caller's membership,
 * never accepted from the client — a client-picked guildId would let anyone
 * hit (or spy on) another guild's boss. Spawn and last week's settlement
 * both happen lazily on the first look of a new week — the gems pattern, no
 * cron; a Render restart can postpone a payout but never lose one.
 *
 * SECURITY: attack is the endpoint that mints value, so it takes the
 * changeUsername treatment — a verified JWT is REQUIRED, no grandfathering.
 * The client sends card IDS and a nonce; ownership, rest, fatigue, caps,
 * every multiplier and the variance roll are all derived server-side.
 */

const REALM = "realm";

/** The caller's encounter key: their guild's id, else the realm sentinel.
 *  Unauthenticated viewers get the realm fight. */
async function encKeyFor(actor: string | null): Promise<string> {
  if (!actor) return REALM;
  const membership = await prisma.guildMember.findUnique({ where: { userId: actor } });
  return membership?.guildId ?? REALM;
}

const dayKey = (d: Date = new Date()) => d.toISOString().slice(0, 10);
const prevWeekKey = () => weekKey(new Date(Date.now() - 7 * 86400000));

/** Deterministic variance in [0.92, 1.08] from the attack nonce — auditable,
 *  and a retry can't reroll it. djb2, then folded to the range. */
function varianceFor(nonce: string): number {
  let h = 5381;
  for (let i = 0; i < nonce.length; i++) h = ((h << 5) + h + nonce.charCodeAt(i)) | 0;
  const unit = ((h >>> 0) % 10000) / 10000;
  return 0.92 + unit * 0.16;
}

/** Printed-or-rolled stats, scaled the way duels scale them, plus forge. */
function effectivePower(uc: {
  cardId: string; level: number; rolledAtk: number | null; rolledHp: number | null;
  atkForge: number; hpForge: number;
}): number {
  const cat = CARDS[uc.cardId];
  const printed = CARD_STATS_BY_ID[uc.cardId] || (cat ? CARD_STATS[cat.rarity] : { hp: 40, atk: 10 });
  const lm = levelMult(uc.level);
  const atk = (uc.rolledAtk ?? printed.atk) * lm + uc.atkForge * FORGE_ATK_STEP;
  const hp = (uc.rolledHp ?? printed.hp) * lm + uc.hpForge * FORGE_HP_STEP;
  return atk + hp / 10;
}

/** Get-or-create this week's boss + the encounter for ONE key (a guild id or
 *  the realm sentinel), settling last week first. Unique constraints make the
 *  create races safe: on P2002 we just refetch. The boss lookup and the
 *  encounter lookup stay independent on purpose — a killed or settled realm
 *  fight must never block a guild's encounter from spawning. */
async function ensureWeek(encKey: string) {
  const week = weekKey();

  // Settlement runs on EVERY look, not only the spawning one: it early-exits
  // on a single cheap findUnique when there's nothing to pay, and this way a
  // transient DB failure during the one spawn-time attempt can't strand last
  // week's payouts as rewarded:false forever.
  await settlePreviousWeek().catch((e) => console.error("Raid settlement error:", e));

  let boss = await prisma.raidBoss.findUnique({ where: { week }, include: { encounters: true } });
  if (!boss) {
    const def = bossForWeek(week);
    try {
      boss = await prisma.raidBoss.create({
        data: { week, slug: def.slug },
        include: { encounters: true },
      });
    } catch (e: any) {
      if (e?.code !== "P2002") throw e;
      boss = await prisma.raidBoss.findUnique({ where: { week }, include: { encounters: true } });
    }
  }
  if (!boss) throw new Error("raid boss spawn failed");

  let enc = boss.encounters.find((e) => e.guildId === encKey) || null;
  if (!enc) {
    const def = bossBySlug(boss.slug);
    const hp = encKey === REALM ? await sizeRealmHp(def) : await sizeGuildHp(encKey, def);
    try {
      enc = await prisma.raidEncounter.create({
        data: { bossId: boss.id, guildId: encKey, hpMax: hp, hpLeft: hp },
      });
    } catch (e: any) {
      if (e?.code !== "P2002") throw e;
      enc = await prisma.raidEncounter.findUnique({
        where: { bossId_guildId: { bossId: boss.id, guildId: encKey } },
      });
    }
  }
  if (!enc) throw new Error("raid encounter spawn failed");
  return { week, boss, enc };
}

/** §3.4 core, ONE function for realm and guild sizing so they cannot drift:
 *  HP = clamp(M_active) × 14 × D_avg × 0.85 (× finale mult), floored at 1000. */
function hpFormula(
  mActive: number,
  minClamp: number,
  dAvg: number,
  def: ReturnType<typeof bossBySlug>
): number {
  const m = Math.min(Math.max(mActive, minClamp), RAID.HP_ACTIVE_MAX);
  const hp = Math.ceil(m * RAID.HP_ATTACKS_PER_MEMBER * dAvg * RAID.HP_TUNING * gimmickHpMult(def.gimmick));
  return Math.max(hp, 1000);
}

/** Distinct attackers and median damage on ONE key's previous-week encounter.
 *  Both null-ish when that key didn't fight last week — the caller decides
 *  what a cold start falls back to. */
async function prevWeekActivity(encKey: string): Promise<{ mActive: number; dMedian: number | null }> {
  const prevBoss = await prisma.raidBoss.findUnique({
    where: { week: prevWeekKey() },
    include: { encounters: { where: { guildId: encKey } } },
  });
  const prevEnc = prevBoss?.encounters[0];
  if (!prevEnc) return { mActive: 0, dMedian: null };
  const damages = await prisma.raidAttack.findMany({
    where: { encounterId: prevEnc.id },
    select: { damage: true, userId: true },
  });
  if (!damages.length) return { mActive: 0, dMedian: null };
  const sorted = damages.map((a) => a.damage).sort((a, b) => a - b);
  return {
    mActive: new Set(damages.map((a) => a.userId)).size,
    dMedian: sorted[Math.floor(sorted.length / 2)] || null,
  };
}

async function sizeRealmHp(def: ReturnType<typeof bossBySlug>): Promise<number> {
  const { mActive, dMedian } = await prevWeekActivity(REALM);
  return hpFormula(mActive, RAID.HP_ACTIVE_MIN, dMedian ?? RAID.COLD_START_AVG_DAMAGE, def);
}

async function sizeGuildHp(guildId: string, def: ReturnType<typeof bossBySlug>): Promise<number> {
  const { mActive, dMedian } = await prevWeekActivity(guildId);
  // Cold start: a guild with no raid history sizes off who's in it TODAY, so
  // its first boss is beatable by the roster it actually has.
  const m = mActive || (await prisma.guildMember.count({ where: { guildId } }));
  return hpFormula(m, RAID.GUILD_HP_ACTIVE_MIN, dMedian ?? RAID.COLD_START_AVG_DAMAGE, def);
}

/**
 * One member's payout for one settled encounter — the SINGLE source of the
 * reward math, used by settlement (to pay) and by getRaid's lastWeek summary
 * (to show what was paid). Keep them identical or the UI lies about money.
 */
function payoutFor(
  attackCount: number,
  damageRankIdx: number,
  ctx: { killed: boolean; fraction: number; rewardMult: number }
): { ap: number; shards: number } {
  let ap = Math.round(RAID.KILL_AP * ctx.rewardMult * ctx.fraction);
  let shards = Math.round(RAID.KILL_SHARDS * ctx.rewardMult * ctx.fraction);
  if (attackCount >= RAID.CONSISTENCY_ATTACKS) {
    ap += Math.round(RAID.CONSISTENCY_AP * ctx.rewardMult * ctx.fraction);
  }
  if (ctx.killed && damageRankIdx > -1 && damageRankIdx < RAID.TOP_DAMAGE_SHARDS.length) {
    shards += RAID.TOP_DAMAGE_SHARDS[damageRankIdx];
  }
  return { ap, shards };
}

function outcomeOf(enc: { hpMax: number; hpLeft: number; killedAt: Date | null }, slug: string) {
  const def = bossBySlug(slug);
  const killed = !!enc.killedAt;
  const dealtRatio = enc.hpMax > 0 ? (enc.hpMax - enc.hpLeft) / enc.hpMax : 0;
  const escapeFraction =
    dealtRatio >= RAID.ESCAPE_CLOSE_RATIO ? RAID.ESCAPE_CLOSE_FRACTION : RAID.ESCAPE_FAR_FRACTION;
  return {
    def,
    killed,
    dealtRatio,
    fraction: killed ? 1 : escapeFraction,
    rewardMult: gimmickRewardMult(def.gimmick),
  };
}

/** Pay out EVERY unrewarded encounter of last week's boss exactly once —
 *  realm and per-guild alike. settleEncounter's rewarded-CAS keeps each one
 *  idempotent, so two concurrent rollovers can't double-pay a guild. */
async function settlePreviousWeek() {
  const prev = await prisma.raidBoss.findUnique({
    where: { week: prevWeekKey() },
    include: { encounters: { where: { rewarded: false } } },
  });
  if (!prev) return;
  for (const enc of prev.encounters) {
    await settleEncounter(prev.id, prev.slug, prev.week, enc);
  }
}

/**
 * userId → the ONE encounter of a boss's week allowed to pay that user.
 *
 * Joins are open and the daily cap is user-global but not encounter-bound,
 * so a player can meet the 3-attack reward gate on several encounters by
 * guild-hopping — and since every encounter settles independently, each one
 * would pay them in full. Splitting 21 weekly attacks across seven guilds
 * that kill anyway would out-earn a loyal member several times over.
 * Home = the encounter with the most of their attacks; ties break to the
 * earliest first attack, then encounter id, so the answer is deterministic
 * however the encounters settle (Monday loop or the dev drill).
 */
async function homeEncounterByUser(bossId: string): Promise<Map<string, string>> {
  const rows = await prisma.raidAttack.groupBy({
    by: ["userId", "encounterId"],
    where: { encounter: { bossId } },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  const best = new Map<string, { encId: string; n: number; t: number }>();
  for (const r of rows) {
    const t = r._min.createdAt ? r._min.createdAt.getTime() : 0;
    const cur = best.get(r.userId);
    if (
      !cur ||
      r._count._all > cur.n ||
      (r._count._all === cur.n && (t < cur.t || (t === cur.t && r.encounterId < cur.encId)))
    ) {
      best.set(r.userId, { encId: r.encounterId, n: r._count._all, t });
    }
  }
  return new Map([...best].map(([u, b]) => [u, b.encId] as [string, string]));
}

/** Settle ONE encounter: compute payouts, pay in a CAS-guarded transaction.
 *  Shared by the Monday rollover and the lead-dev settle-now drill. */
async function settleEncounter(
  bossId: string,
  slug: string,
  week: string,
  enc: { id: string; hpMax: number; hpLeft: number; killedAt: Date | null }
) {
  const def = bossBySlug(slug);
  const { killed, dealtRatio, fraction, rewardMult } = outcomeOf(enc, slug);

  const per = await prisma.raidAttack.groupBy({
    by: ["userId"],
    where: { encounterId: enc.id },
    _count: { _all: true },
    _sum: { damage: true },
  });

  const gatedAll = per.filter((p) => p._count._all >= RAID.REWARD_GATE_ATTACKS);
  // Pre-filter to accounts that still exist. Catching a failed update INSIDE
  // the transaction would not save it — Postgres aborts the whole tx on the
  // first error and every later query fails — so the filtering happens here.
  const existing = gatedAll.length
    ? new Set(
        (
          await prisma.user.findMany({
            where: { id: { in: gatedAll.map((p) => p.userId) } },
            select: { id: true },
          })
        ).map((u) => u.id)
      )
    : new Set<string>();
  // Anti-tourism: this encounter only pays users whose HOME it is (see
  // homeEncounterByUser). The rank ladder is filtered the same way so a
  // tourist's damage can't hold a top-damage shard slot either.
  const home = await homeEncounterByUser(bossId);
  const gated = gatedAll.filter(
    (p) => existing.has(p.userId) && home.get(p.userId) === enc.id
  );
  const byDamage = [...gated].sort((a, b) => (b._sum.damage || 0) - (a._sum.damage || 0));

  await prisma.$transaction(async (tx) => {
    // COMPARE-AND-SET, not read-then-write: under READ COMMITTED two racers
    // can both read rewarded=false and both pay. updateMany's predicate is
    // re-evaluated against the committed row after the lock clears, so the
    // loser matches 0 rows and exits without paying — the same conditional
    // pattern the kill claim uses.
    const claimed = await tx.raidEncounter.updateMany({
      where: { id: enc.id, rewarded: false },
      data: { rewarded: true },
    });
    if (claimed.count === 0) return;

    for (const p of gated) {
      const rank = byDamage.findIndex((r) => r.userId === p.userId);
      const { ap, shards } = payoutFor(p._count._all, rank, { killed, fraction, rewardMult });
      if (ap <= 0 && shards <= 0) continue;
      await tx.user.update({
        where: { id: p.userId },
        data: {
          ...(ap > 0 && { arisePoints: { increment: ap } }),
          ...(shards > 0 && { shards: { increment: shards } }),
        },
      });
      if (ap > 0) {
        await tx.pointLog.create({
          data: {
            userId: p.userId,
            amount: ap,
            reason: killed
              ? `Raid: ${def.name} slain (${week})`
              : `Raid: ${def.name} escaped at ${(dealtRatio * 100).toFixed(0)}% (${week})`,
          },
        });
      }
    }
  });
}

// ── GET /api/raid ───────────────────────────────────────────────────────────

export const getRaid = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActorId(req);
    const encKey = await encKeyFor(actor);
    const { week, boss, enc } = await ensureWeek(encKey);
    const def = bossBySlug(boss.slug);
    const day = dayKey();

    // Whose fight the caller is looking at — null means the realm-wide one.
    const guild =
      encKey === REALM
        ? null
        : await prisma.guild.findUnique({
            where: { id: encKey },
            select: { id: true, name: true, tag: true },
          });

    let mine: { attacksToday: number; usedCardIds: string[]; myDamage: number; myAttacks: number } = {
      attacksToday: 0, usedCardIds: [], myDamage: 0, myAttacks: 0,
    };
    if (actor) {
      // attacksToday/usedCardIds are USER-global, not encounter-scoped —
      // they mirror the enforcement in raidAttack, which counts across all
      // encounters so a mid-day guild hop can't reset the cap. Scoping the
      // display to the encounter would show an available attack that 429s.
      const todays = await prisma.raidAttack.findMany({
        where: { userId: actor, day },
        select: { squad: true },
      });
      const all = await prisma.raidAttack.aggregate({
        where: { encounterId: enc.id, userId: actor },
        _count: { _all: true },
        _sum: { damage: true },
      });
      mine = {
        attacksToday: todays.length,
        usedCardIds: todays.flatMap((a) => ((a.squad as any[]) || []).map((l) => String(l.cardId))),
        myDamage: all._sum.damage || 0,
        myAttacks: all._count._all,
      };
    }

    // Last week's story — outcome and, for the signed-in caller, what the
    // settlement paid them. payoutFor is the same function settlement used,
    // so this can't drift from the actual money.
    let lastWeek: any = null;
    const prevBoss = await prisma.raidBoss.findUnique({
      where: { week: prevWeekKey() },
      include: { encounters: { where: { guildId: { in: [encKey, REALM] } } } },
    });
    // The caller's own fight when their key had one last week; the realm
    // fight otherwise, so a freshly-founded guild's card still tells a story.
    const prevEnc =
      prevBoss?.encounters.find((e) => e.guildId === encKey) ??
      prevBoss?.encounters.find((e) => e.guildId === REALM);
    if (prevBoss && prevEnc) {
      const o = outcomeOf(prevEnc, prevBoss.slug);
      lastWeek = {
        week: prevBoss.week,
        name: o.def.name,
        slug: o.def.slug,
        killed: o.killed,
        dealtRatio: Math.round(o.dealtRatio * 1000) / 1000,
        settled: prevEnc.rewarded,
        mine: null,
      };
      if (actor) {
        const gatedRows = await prisma.raidAttack.groupBy({
          by: ["userId"],
          where: { encounterId: prevEnc.id },
          _count: { _all: true },
          _sum: { damage: true },
        });
        const meRow = gatedRows.find((r) => r.userId === actor);
        if (meRow) {
          // Same home-encounter rule as settlement — without it this card
          // would promise a guild-hopper money the settlement never paid.
          const home = await homeEncounterByUser(prevBoss.id);
          const gatedSorted = gatedRows
            .filter(
              (r) =>
                r._count._all >= RAID.REWARD_GATE_ATTACKS &&
                home.get(r.userId) === prevEnc.id
            )
            .sort((a, b) => (b._sum.damage || 0) - (a._sum.damage || 0));
          const rank = gatedSorted.findIndex((r) => r.userId === actor);
          const eligible =
            meRow._count._all >= RAID.REWARD_GATE_ATTACKS &&
            home.get(actor) === prevEnc.id;
          const paid = eligible
            ? payoutFor(meRow._count._all, rank, o)
            : { ap: 0, shards: 0 };
          lastWeek.mine = {
            attacks: meRow._count._all,
            damage: meRow._sum.damage || 0,
            rank: rank > -1 ? rank + 1 : null,
            eligible,
            ap: paid.ap,
            shards: paid.shards,
          };
        }
      }
    }

    const top = await prisma.raidAttack.groupBy({
      by: ["userId"],
      where: { encounterId: enc.id },
      _sum: { damage: true },
      orderBy: { _sum: { damage: "desc" } },
      take: 10,
    });
    const users = top.length
      ? await prisma.user.findMany({
          where: { id: { in: top.map((t) => t.userId) } },
          select: { id: true, username: true, avatar: true },
        })
      : [];
    const standings = top.map((t) => {
      const u = users.find((x) => x.id === t.userId);
      return { username: u?.username || "?", avatar: u?.avatar || null, damage: t._sum.damage || 0 };
    });

    res.json({
      success: true,
      data: {
        week,
        guild,
        boss: {
          slug: def.slug, name: def.name, series: def.series, art: def.art,
          flavor: def.flavor, gimmickText: def.gimmickText,
        },
        hpMax: enc.hpMax,
        hpLeft: enc.hpLeft,
        killedAt: enc.killedAt,
        freeAttacksPerDay: RAID.FREE_ATTACKS_PER_DAY,
        maxAttacksPerDay: RAID.MAX_ATTACKS_PER_DAY,
        rallyCost: RAID.RALLY_COST_AP,
        squadSize: RAID.SQUAD_SIZE,
        mine,
        standings,
        lastWeek,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── Lead-dev drill ops (mounted under /api/console) ─────────────────────────
// The phase-3 proof: set the boss's HP low, land a real killing blow, then
// force the settlement without waiting for Monday. Both are leadDevOnly and
// operate on the CURRENT week's encounter for the LEAD DEV'S OWN key — their
// guild's fight when they're in one, else the realm — so the drill demos the
// same encounter their attacks land on.

/** POST /api/console/ops/raid-hp  body: { hpLeft } — set the live boss's HP. */
export const raidDevSetHp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;
    const hpLeft = Math.floor(Number(req.body?.hpLeft));
    if (!Number.isFinite(hpLeft) || hpLeft < 1) {
      return res.status(400).json({ success: false, message: "hpLeft must be a number ≥ 1 — land the kill with a real attack." });
    }
    const { boss, enc } = await ensureWeek(await encKeyFor(actor.id));
    if (enc.killedAt) {
      return res.status(409).json({ success: false, message: "The boss is already down this week." });
    }
    const updated = await prisma.raidEncounter.update({
      where: { id: enc.id },
      data: { hpLeft: Math.min(hpLeft, enc.hpMax) },
    });
    return res.json({ success: true, data: { week: boss.week, hpLeft: updated.hpLeft, hpMax: updated.hpMax } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/console/ops/raid-settle — settle THIS week's encounter now.
 *  Idempotent via the same rewarded CAS; Monday's pass will then skip it. */
export const raidDevSettleNow = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;
    const { week, boss, enc } = await ensureWeek(await encKeyFor(actor.id));
    if (enc.rewarded) {
      return res.status(409).json({ success: false, message: "This week is already settled." });
    }
    await settleEncounter(boss.id, boss.slug, week, enc);
    const after = await prisma.raidEncounter.findUnique({ where: { id: enc.id } });
    return res.json({
      success: true,
      data: { week, settled: !!after?.rewarded, killed: !!after?.killedAt },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/raid/attack ───────────────────────────────────────────────────

export const raidAttack = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // HARD gate — this endpoint mints value. No pre-JWT grandfathering.
    const actor = getActorId(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in again to raid." });
    }

    const squadIds: string[] = Array.isArray(req.body?.squadCardIds)
      ? req.body.squadCardIds.map(String)
      : [];
    const nonce: string = String(req.body?.nonce || "");
    if (new Set(squadIds).size !== RAID.SQUAD_SIZE) {
      return res.status(400).json({ success: false, message: `Pick exactly ${RAID.SQUAD_SIZE} different cards.` });
    }
    if (!nonce || nonce.length > 80) {
      return res.status(400).json({ success: false, message: "Missing attack nonce." });
    }

    // Idempotency: a replayed nonce returns the original report, no new damage.
    const replay = await prisma.raidAttack.findUnique({ where: { nonce } });
    if (replay) {
      return res.json({ success: true, replay: true, data: { damage: replay.damage, lines: replay.squad } });
    }

    const encKey = await encKeyFor(actor);
    const { boss, enc } = await ensureWeek(encKey);
    const def = bossBySlug(boss.slug);
    if (enc.killedAt) {
      return res.status(409).json({ success: false, message: `${def.name} has already fallen this week.` });
    }

    // The daily cap and card fatigue are PER USER, across ALL encounters —
    // scoping them to enc.id would let leaving guild A for guild B mid-day
    // reset both and double a player's attacks.
    const day = dayKey();
    const todays = await prisma.raidAttack.findMany({
      where: { userId: actor, day },
      select: { squad: true },
    });
    if (todays.length >= RAID.MAX_ATTACKS_PER_DAY) {
      return res.status(429).json({ success: false, message: "No attacks left today — the boss resets at midnight UTC." });
    }

    // Fatigue: one appearance per card per UTC day. (This and the cap above
    // are fast-path UX only — the transaction re-derives both under a lock.)
    const usedToday = new Set(
      todays.flatMap((a) => ((a.squad as any[]) || []).map((l) => String(l.cardId)))
    );
    const tired = squadIds.filter((id) => usedToday.has(id));
    if (tired.length) {
      return res.status(409).json({ success: false, message: "Some of those cards already fought today — they're resting." });
    }

    // squadIds are CATALOG card ids — the id currency of the whole frontend
    // (the collection endpoint never exposes UserCard row ids). Safe because
    // @@unique([userId, cardId]) makes catalog ids 1:1 with rows per user.
    const owned = await prisma.userCard.findMany({
      where: { cardId: { in: squadIds }, userId: actor, count: { gt: 0 } },
    });

    // ── GUILD CARD LOANS ── squad ids the actor doesn't own may be borrowed
    // from a guildmate. A borrowed card fights as the OWNER's copy: the
    // owner's UserCard row supplies stats/level/forge, the owner's prints
    // supply condition, and an injury sets raidRestUntil on the OWNER's row —
    // lending is real, your card comes back tired. Fatigue stays keyed on the
    // BORROWER's own attacks by catalog cardId, unchanged.
    const now = new Date();
    const ownedIds = new Set(owned.map((c) => c.cardId));
    const missing = squadIds.filter((id) => !ownedIds.has(id));
    let borrowed: typeof owned = [];
    if (missing.length) {
      const loans = await prisma.guildCardLoan.findMany({
        where: { borrowerId: actor, cardId: { in: missing }, expiresAt: { gt: now } },
      });
      if (loans.length) {
        const rows = await prisma.userCard.findMany({
          where: {
            OR: loans.map((l) => ({ userId: l.ownerId, cardId: l.cardId })),
            count: { gt: 0 },
          },
        });
        // One usable row per missing catalog id — if the same card is somehow
        // on loan from two owners, the first row stands in for it.
        const byCardId = new Map<string, (typeof owned)[number]>();
        for (const r of rows) if (!byCardId.has(r.cardId)) byCardId.set(r.cardId, r);
        borrowed = missing
          .map((id) => byCardId.get(id))
          .filter((r): r is (typeof owned)[number] => !!r);
      }
    }

    const cards = [...owned, ...borrowed];
    if (cards.length !== RAID.SQUAD_SIZE) {
      return res.status(400).json({ success: false, message: "You don't own (or hold an active guild loan for) all of those cards." });
    }
    const resting = cards.filter((c) => c.raidRestUntil && c.raidRestUntil > now);
    if (resting.length) {
      return res.status(409).json({ success: false, message: "An injured card is still resting from a raid." });
    }

    // Best print condition per legendary card (fresh > factory > rusted).
    // Prints belong to the row's OWNER — for a borrowed card that's the
    // lender, not the actor, so the lookup is keyed per (owner, card).
    const legendaryRows = cards.filter((c) => CARDS[c.cardId]?.rarity === "legendary");
    const prints = legendaryRows.length
      ? await prisma.cardPrint.findMany({
          where: { OR: legendaryRows.map((c) => ({ userId: c.userId, cardId: c.cardId })) },
          select: { userId: true, cardId: true, condition: true },
        })
      : [];
    const bestCondition = (ownerId: string, cardId: string): string | null => {
      const mine = prints.filter((p) => p.userId === ownerId && p.cardId === cardId);
      if (!mine.length) return null;
      if (mine.some((p) => p.condition === "fresh")) return "fresh";
      if (mine.some((p) => p.condition === "factory")) return "factory";
      return "rusted";
    };

    // Collector's pride: distinct sets fielded this week (before this attack).
    // Joined through the boss, not the encounter, so the streak follows the
    // player across a mid-week guild switch instead of resetting.
    const weekAttacks = await prisma.raidAttack.findMany({
      where: { userId: actor, encounter: { bossId: boss.id } },
      select: { squad: true },
    });
    const setsThisWeek = new Set(
      weekAttacks.flatMap((a) => ((a.squad as any[]) || []).map((l) => String(l.set || "")))
    );
    cards.forEach((c) => setsThisWeek.add(CARDS[c.cardId]?.set || ""));
    setsThisWeek.delete("");
    const varietyMult = gimmickVarietyMult(def.gimmick, setsThisWeek.size);

    // ── the formula (§4.2) ──
    // The RNG seed is SERVER-generated. The nonce is client-chosen and
    // varianceFor is a public hash, so seeding from the nonce would let a
    // script offline-mine a nonce with max variance AND all-miss injury
    // rolls — permanent +8% damage and injury immunity that reads as luck.
    // The nonce stays purely an idempotency key; replays return the STORED
    // report, so determinism-across-retries never needed the nonce seed.
    const seed = randomUUID();
    const variance = varianceFor(seed);
    const affinityMult = gimmickAffinityMult(def.gimmick);
    const injuryMult = gimmickInjuryMult(def.gimmick);
    const injuredIds: string[] = [];
    const lines = cards.map((uc) => {
      const cat = CARDS[uc.cardId];
      const rarity = cat?.rarity || "common";
      const base = effectivePower(uc);
      const rarityMult = RAID.RARITY_MULT[rarity] ?? 1;
      const cond = bestCondition(uc.userId, uc.cardId);
      const condMult = cond ? RAID.CONDITION_MULT[cond] ?? 1 : 1;
      const isAffine = !!cat && cat.set === def.series;
      const affMult = isAffine ? affinityMult : 1;
      const gimMult = gimmickDamageMult(def.gimmick, rarity);
      const line = base * rarityMult * condMult * affMult * gimMult;

      // Injury roll — deterministic per attack+card, same seed family as
      // variance. roll is uniform on [0, 0.16), so the threshold that yields
      // P(injured) = chance is chance × 0.16.
      const baseChance = cond === "fresh" ? RAID.INJURY_CHANCE_FRESH : RAID.INJURY_CHANCE;
      const roll = varianceFor(`${seed}:${uc.id}`) - 0.92;
      const injured = roll < baseChance * injuryMult * 0.16;
      if (injured) injuredIds.push(uc.id);

      return {
        userCardId: uc.id,
        cardId: uc.cardId,
        name: cat?.name || uc.cardId,
        set: cat?.set || "",
        rarity,
        base: Math.round(base),
        rarityMult,
        condition: cond,
        condMult,
        affinity: isAffine,
        affMult,
        gimMult,
        varietyMult,
        line: Math.round(line * varietyMult),
        injured,
      };
    });
    const damage = Math.max(1, Math.round(lines.reduce((s, l) => s + l.line, 0) * variance));

    const restUntil = new Date(Date.now() + RAID.INJURY_REST_HOURS * 3600000);

    const result = await prisma.$transaction(async (tx) => {
      // ── AUTHORITATIVE re-checks under a per-user row lock ──
      // The reads above were UX fast-paths; N parallel POSTs with N distinct
      // nonces would all pass them (RaidAttack's only unique is the nonce),
      // dodging the daily cap, the fatigue rule and the Rally charge at
      // once. FOR UPDATE on the user's row serializes this user's attacks;
      // everything economic is then re-derived from tx-consistent reads.
      await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${actor} FOR UPDATE`;
      // Cross-encounter on purpose, matching the fast path above — the cap
      // and fatigue belong to the USER's day, not to any one encounter.
      const txTodays = await tx.raidAttack.findMany({
        where: { userId: actor, day },
        select: { squad: true },
      });
      if (txTodays.length >= RAID.MAX_ATTACKS_PER_DAY) {
        throw Object.assign(new Error("raid-capped"), { raidCode: 429 });
      }
      const txUsed = new Set(
        txTodays.flatMap((a) => ((a.squad as any[]) || []).map((l) => String(l.cardId)))
      );
      if (squadIds.some((id) => txUsed.has(id))) {
        throw Object.assign(new Error("raid-fatigued"), { raidCode: 409 });
      }
      const txIsRally = txTodays.length >= RAID.FREE_ATTACKS_PER_DAY;

      // The rally attack pays inside the same transaction: a conditional
      // decrement, so an insufficient balance can never go negative.
      if (txIsRally) {
        const paid = await tx.user.updateMany({
          where: { id: actor, arisePoints: { gte: RAID.RALLY_COST_AP } },
          data: { arisePoints: { decrement: RAID.RALLY_COST_AP } },
        });
        if (paid.count === 0) {
          throw Object.assign(new Error("rally-unaffordable"), { raidCode: 402 });
        }
        await tx.pointLog.create({
          data: { userId: actor, amount: -RAID.RALLY_COST_AP, reason: `Raid Rally (${boss.week})` },
        });
      }

      await tx.raidAttack.create({
        data: {
          encounterId: enc.id,
          userId: actor,
          day,
          squad: lines as unknown as Prisma.InputJsonValue,
          damage,
          isRally: txIsRally,
          nonce,
        },
      });

      // Guild progression: every attack on a GUILD encounter feeds the
      // guild's xp. updateMany, not update — a guild disbanded mid-week
      // would make update throw P2025 and poison the whole attack
      // transaction; here a vanished guild just matches zero rows. Realm
      // fights feed nothing: the realm sentinel has no Guild row.
      if (encKey !== REALM) {
        await tx.guild.updateMany({
          where: { id: encKey },
          data: { xp: { increment: RAID.GUILD_ATTACK_XP } },
        });
      }

      await tx.raidEncounter.update({
        where: { id: enc.id },
        data: { hpLeft: { decrement: damage } },
      });
      // Clamp and claim the kill — first writer past zero wins the blow.
      // The claim count is the ONLY honest killing-blow signal: in a race,
      // both attackers see killedAt set afterwards, but exactly one of these
      // updateMany calls matched a row.
      const claim = await tx.raidEncounter.updateMany({
        where: { id: enc.id, hpLeft: { lte: 0 }, killedAt: null },
        data: { killedAt: new Date() },
      });
      // The killing blow pays the GUILD row: the kill xp bonus plus treasury
      // shards. Same updateMany guard as the attack xp above (a disbanded
      // guild matches zero rows instead of aborting the tx), and same realm
      // rule — a realm kill feeds nothing, there's no Guild row behind the
      // sentinel. These are GUILD-row shards, never any user's; member
      // payouts happen at settlement.
      if (claim.count === 1 && encKey !== REALM) {
        await tx.guild.updateMany({
          where: { id: encKey },
          data: {
            xp: { increment: RAID.GUILD_KILL_XP },
            shards: { increment: RAID.GUILD_KILL_SHARDS },
          },
        });
      }
      await tx.raidEncounter.updateMany({
        where: { id: enc.id, hpLeft: { lt: 0 } },
        data: { hpLeft: 0 },
      });

      if (injuredIds.length) {
        await tx.userCard.updateMany({
          where: { id: { in: injuredIds } },
          data: { raidRestUntil: restUntil },
        });
      }

      const after = await tx.raidEncounter.findUnique({ where: { id: enc.id } });
      return { after, killingBlow: claim.count === 1, isRally: txIsRally };
    }).catch((e) => {
      if (e?.raidCode === 402) return "unaffordable" as const;
      if (e?.raidCode === 429) return "capped" as const;
      if (e?.raidCode === 409) return "fatigued" as const;
      if (e?.code === "P2002") return "replayed" as const; // nonce raced its own retry
      throw e;
    });

    if (result === "unaffordable") {
      return res.status(402).json({
        success: false,
        message: `A third attack today is a Rally — it costs ${RAID.RALLY_COST_AP} AP and you don't have enough.`,
      });
    }
    if (result === "capped") {
      return res.status(429).json({ success: false, message: "No attacks left today — the boss resets at midnight UTC." });
    }
    if (result === "fatigued") {
      return res.status(409).json({ success: false, message: "Some of those cards already fought today — they're resting." });
    }
    if (result === "replayed") {
      const again = await prisma.raidAttack.findUnique({ where: { nonce } });
      return res.json({ success: true, replay: true, data: { damage: again?.damage || 0, lines: again?.squad || [] } });
    }

    return res.json({
      success: true,
      data: {
        damage,
        isRally: result?.isRally ?? false,
        variance: Math.round(variance * 100) / 100,
        lines,
        injuredCount: injuredIds.length,
        restUntil: injuredIds.length ? restUntil : null,
        hpLeft: result?.after?.hpLeft ?? 0,
        hpMax: result?.after?.hpMax ?? 0,
        killed: !!result?.after?.killedAt,
        killingBlow: !!result?.killingBlow,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/raid/leaderboard ───────────────────────────────────────────────

export const raidLeaderboard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Soft auth — signed-out viewers see the realm fight's board.
    const { boss, enc } = await ensureWeek(await encKeyFor(getActorId(req)));
    const def = bossBySlug(boss.slug);
    const per = await prisma.raidAttack.groupBy({
      by: ["userId"],
      where: { encounterId: enc.id },
      _sum: { damage: true },
      _count: { _all: true },
      orderBy: { _sum: { damage: "desc" } },
      take: 25,
    });
    const users = per.length
      ? await prisma.user.findMany({
          where: { id: { in: per.map((p) => p.userId) } },
          select: { id: true, username: true, avatar: true },
        })
      : [];
    res.json({
      success: true,
      data: {
        week: boss.week,
        boss: { name: def.name, slug: def.slug },
        hpMax: enc.hpMax,
        hpLeft: enc.hpLeft,
        rows: per.map((p) => {
          const u = users.find((x) => x.id === p.userId);
          return {
            username: u?.username || "?",
            avatar: u?.avatar || null,
            damage: p._sum.damage || 0,
            attacks: p._count._all,
          };
        }),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/raid/history ───────────────────────────────────────────────────

export const raidHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Soft auth — the caller's key picks whose record this is.
    const encKey = await encKeyFor(getActorId(req));
    const bosses = await prisma.raidBoss.findMany({
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { encounters: { where: { guildId: { in: [encKey, REALM] } } } },
    });
    // The caller's-key fight when that week had one, else the realm fight —
    // a guild founded mid-season still sees every week's story.
    const pick = (b: (typeof bosses)[number]) =>
      b.encounters.find((e) => e.guildId === encKey) ?? b.encounters.find((e) => e.guildId === REALM);
    const guild =
      encKey === REALM
        ? null
        : await prisma.guild.findUnique({
            where: { id: encKey },
            select: { id: true, name: true, tag: true },
          });
    // The phase-4 season record: kills among the 8 most recent weeks. A
    // SIBLING of data, not a reshape of it — the history list is already a
    // deployed contract and the array must stay an array. `guild` is a
    // sibling too, for the same reason.
    const SEASON_WEEKS = 8;
    const cleared = bosses
      .slice(0, SEASON_WEEKS)
      .filter((b) => !!pick(b)?.killedAt).length;
    res.json({
      success: true,
      data: bosses.map((b) => {
        const def = bossBySlug(b.slug);
        const e = pick(b);
        return {
          week: b.week,
          name: def.name,
          series: def.series,
          art: def.art,
          killed: !!e?.killedAt,
          dealtRatio: e && e.hpMax > 0 ? Math.round(((e.hpMax - e.hpLeft) / e.hpMax) * 100) / 100 : 0,
        };
      }),
      season: { cleared, total: SEASON_WEEKS },
      guild,
    });
  } catch (error) {
    next(error);
  }
};
