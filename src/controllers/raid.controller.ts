import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { weekKey } from "./gem.controller";
import { CARDS, levelMult, FORGE_ATK_STEP, FORGE_HP_STEP } from "../data/cardCatalog";
import { CARD_STATS_BY_ID, CARD_STATS } from "../data/duelRules";
import {
  RAID, bossForWeek, bossBySlug,
  gimmickDamageMult, gimmickAffinityMult, gimmickVarietyMult,
  gimmickInjuryMult, gimmickHpMult, gimmickRewardMult,
} from "../data/raidBosses";

/**
 * GUILD RAID BOSS — phase 1, realm mode.
 *
 * One boss per ISO week; ONE encounter shared by the whole server (guildId
 * sentinel "realm") until guilds exist, at which point per-guild encounters
 * slot into the same tables. Spawn and last week's settlement both happen
 * lazily on the first look of a new week — the gems pattern, no cron; a
 * Render restart can postpone a payout but never lose one.
 *
 * SECURITY: attack is the endpoint that mints value, so it takes the
 * changeUsername treatment — a verified JWT is REQUIRED, no grandfathering.
 * The client sends card IDS and a nonce; ownership, rest, fatigue, caps,
 * every multiplier and the variance roll are all derived server-side.
 */

const REALM = "realm";

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

/** Get-or-create this week's boss + realm encounter, settling last week first.
 *  Unique constraints make the create races safe: on P2002 we just refetch. */
async function ensureWeek() {
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

  let enc = boss.encounters.find((e) => e.guildId === REALM) || null;
  if (!enc) {
    const hp = await sizeRealmHp(bossBySlug(boss.slug));
    try {
      enc = await prisma.raidEncounter.create({
        data: { bossId: boss.id, guildId: REALM, hpMax: hp, hpLeft: hp },
      });
    } catch (e: any) {
      if (e?.code !== "P2002") throw e;
      enc = await prisma.raidEncounter.findUnique({
        where: { bossId_guildId: { bossId: boss.id, guildId: REALM } },
      });
    }
  }
  if (!enc) throw new Error("raid encounter spawn failed");
  return { week, boss, enc };
}

/** §3.4, realm clamps: HP = M_active × 14 × D_avg × 0.85 (× finale mult). */
async function sizeRealmHp(def: ReturnType<typeof bossBySlug>): Promise<number> {
  const prevBoss = await prisma.raidBoss.findUnique({
    where: { week: prevWeekKey() },
    include: { encounters: { where: { guildId: REALM } } },
  });
  let mActive = 0;
  let dAvg = RAID.COLD_START_AVG_DAMAGE;
  const prevEnc = prevBoss?.encounters[0];
  if (prevEnc) {
    const damages = await prisma.raidAttack.findMany({
      where: { encounterId: prevEnc.id },
      select: { damage: true, userId: true },
    });
    if (damages.length) {
      mActive = new Set(damages.map((a) => a.userId)).size;
      const sorted = damages.map((a) => a.damage).sort((a, b) => a - b);
      dAvg = sorted[Math.floor(sorted.length / 2)] || dAvg;
    }
  }
  const m = Math.min(Math.max(mActive, RAID.HP_ACTIVE_MIN), RAID.HP_ACTIVE_MAX);
  const hp = Math.ceil(m * RAID.HP_ATTACKS_PER_MEMBER * dAvg * RAID.HP_TUNING * gimmickHpMult(def.gimmick));
  return Math.max(hp, 1000);
}

/** Pay out last week's realm encounter exactly once. */
async function settlePreviousWeek() {
  const prev = await prisma.raidBoss.findUnique({
    where: { week: prevWeekKey() },
    include: { encounters: { where: { guildId: REALM, rewarded: false } } },
  });
  const enc = prev?.encounters[0];
  if (!prev || !enc) return;

  const def = bossBySlug(prev.slug);
  const rewardMult = gimmickRewardMult(def.gimmick);
  const killed = !!enc.killedAt;
  const dealtRatio = enc.hpMax > 0 ? (enc.hpMax - enc.hpLeft) / enc.hpMax : 0;
  const escapeFraction =
    dealtRatio >= RAID.ESCAPE_CLOSE_RATIO ? RAID.ESCAPE_CLOSE_FRACTION : RAID.ESCAPE_FAR_FRACTION;
  const fraction = killed ? 1 : escapeFraction;

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
  const gated = gatedAll.filter((p) => existing.has(p.userId));
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
      let ap = Math.round(RAID.KILL_AP * rewardMult * fraction);
      let shards = Math.round(RAID.KILL_SHARDS * rewardMult * fraction);
      if (p._count._all >= RAID.CONSISTENCY_ATTACKS) {
        ap += Math.round(RAID.CONSISTENCY_AP * rewardMult * fraction);
      }
      const rank = byDamage.findIndex((r) => r.userId === p.userId);
      if (killed && rank > -1 && rank < RAID.TOP_DAMAGE_SHARDS.length) {
        shards += RAID.TOP_DAMAGE_SHARDS[rank];
      }
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
              ? `Raid: ${def.name} slain (${prev.week})`
              : `Raid: ${def.name} escaped at ${(dealtRatio * 100).toFixed(0)}% (${prev.week})`,
          },
        });
      }
    }
  });
}

// ── GET /api/raid ───────────────────────────────────────────────────────────

export const getRaid = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { week, boss, enc } = await ensureWeek();
    const def = bossBySlug(boss.slug);
    const actor = getActorId(req);
    const day = dayKey();

    let mine: { attacksToday: number; usedCardIds: string[]; myDamage: number; myAttacks: number } = {
      attacksToday: 0, usedCardIds: [], myDamage: 0, myAttacks: 0,
    };
    if (actor) {
      const todays = await prisma.raidAttack.findMany({
        where: { encounterId: enc.id, userId: actor, day },
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
      },
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

    const { boss, enc } = await ensureWeek();
    const def = bossBySlug(boss.slug);
    if (enc.killedAt) {
      return res.status(409).json({ success: false, message: `${def.name} has already fallen this week.` });
    }

    const day = dayKey();
    const todays = await prisma.raidAttack.findMany({
      where: { encounterId: enc.id, userId: actor, day },
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
    const cards = await prisma.userCard.findMany({
      where: { cardId: { in: squadIds }, userId: actor, count: { gt: 0 } },
    });
    if (cards.length !== RAID.SQUAD_SIZE) {
      return res.status(400).json({ success: false, message: "You don't own all of those cards." });
    }
    const now = new Date();
    const resting = cards.filter((c) => c.raidRestUntil && c.raidRestUntil > now);
    if (resting.length) {
      return res.status(409).json({ success: false, message: "An injured card is still resting from a raid." });
    }

    // Best owned print condition per legendary card (fresh > factory > rusted).
    const legendaryIds = cards
      .filter((c) => CARDS[c.cardId]?.rarity === "legendary")
      .map((c) => c.cardId);
    const prints = legendaryIds.length
      ? await prisma.cardPrint.findMany({
          where: { userId: actor, cardId: { in: legendaryIds } },
          select: { cardId: true, condition: true },
        })
      : [];
    const bestCondition = (cardId: string): string | null => {
      const mine = prints.filter((p) => p.cardId === cardId);
      if (!mine.length) return null;
      if (mine.some((p) => p.condition === "fresh")) return "fresh";
      if (mine.some((p) => p.condition === "factory")) return "factory";
      return "rusted";
    };

    // Collector's pride: distinct sets fielded this week (before this attack).
    const weekAttacks = await prisma.raidAttack.findMany({
      where: { encounterId: enc.id, userId: actor },
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
      const cond = bestCondition(uc.cardId);
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
      const txTodays = await tx.raidAttack.findMany({
        where: { encounterId: enc.id, userId: actor, day },
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

export const raidLeaderboard = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { boss, enc } = await ensureWeek();
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

export const raidHistory = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const bosses = await prisma.raidBoss.findMany({
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { encounters: { where: { guildId: REALM } } },
    });
    res.json({
      success: true,
      data: bosses.map((b) => {
        const def = bossBySlug(b.slug);
        const e = b.encounters[0];
        return {
          week: b.week,
          name: def.name,
          series: def.series,
          art: def.art,
          killed: !!e?.killedAt,
          dealtRatio: e && e.hpMax > 0 ? Math.round(((e.hpMax - e.hpLeft) / e.hpMax) * 100) / 100 : 0,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
};
