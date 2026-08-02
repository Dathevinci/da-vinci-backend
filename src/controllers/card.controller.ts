import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { getRole } from "../utils/economy";
import { CARD_STATS, FOIL_MULT } from "../data/duelRules";
import {
  CARDS,
  PACK_PRICE,
  PACK_SIZE,
  PULL_SIZES,
  PULL_PRICES,
  DUST_VALUE,
  CRAFT_COST,
  WAKE_COST,
  MAX_CARD_LEVEL,
  upgradeCost,
  levelMult,
  FOIL_COST,
  RELIC_PACK_SHARDS,
  SET_REWARDS,
  cardsInSet,
  rollPack,
  rollRelicPack,
  SKILLS,
  MAX_SKILL_LEVEL,
  abilityFor,
  DOMAINS,
  MAX_DOMAIN_LEVEL,
  domainPower,
  domainUpgradeCost,
  skillPower,
  skillUpgradeCost,
} from "../data/cardCatalog";

/**
 * ARISE CARDS — collectible packs, dusting and crafting.
 *
 * The single AP touchpoint is opening a pack (the sink). Every currency debit
 * here — AP for a pack, shards for a craft — uses a CONDITIONAL updateMany
 * (`where balance >= cost`) so the balance check and the deduction are one
 * atomic DB op: a user firing two pack-opens at once can't spend the same
 * points twice. (Same lesson as the auction escrow.)
 *
 * Soft-gated like purchase/gift: a verified token must match the target;
 * tokenless pre-JWT sessions are grandfathered.
 */

// GET /api/cards/catalog — the whole set + economy constants, so the frontend
// has ONE source of truth for card data (no duplicated catalog to drift).
export const getCatalog = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: {
        cards: Object.values(CARDS),
        packPrice: PACK_PRICE,
        packSize: PACK_SIZE,
        pullSizes: PULL_SIZES,
        pullPrices: PULL_PRICES,
        dustValue: DUST_VALUE,
        craftCost: CRAFT_COST,
        wakeCost: WAKE_COST,
        maxCardLevel: MAX_CARD_LEVEL,
        // Base cost per rarity; the client raises it by 1.35^(level-1) to match
        // upgradeCost() exactly, so the price shown is the price charged.
        upgradeBase: { common: 30, rare: 70, epic: 160, legendary: 380, event: 300 },
        upgradeGrowth: 1.35,
        levelStep: 0.07,
        foilCost: FOIL_COST,
        relicPackShards: RELIC_PACK_SHARDS,
        setRewards: SET_REWARDS,
        // Combat stats ship with the catalog so the UI can show what a card
        // DOES without duplicating the table and letting it drift.
        cardStats: CARD_STATS,
        foilMult: FOIL_MULT,
        maxSkillLevel: MAX_SKILL_LEVEL,
        maxDomainLevel: MAX_DOMAIN_LEVEL,
        /**
         * Legendary DOMAIN EXPANSIONS. A separate map from skills, with kinds
         * that share nothing with them — a legendary is meant to be a
         * different kind of card, not an epic with bigger numbers.
         */
        domains: Object.fromEntries(
          Object.entries(DOMAINS).map(([id, d]) => [
            id,
            {
              name: d.name,
              kind: d.kind,
              levels: Array.from({ length: MAX_DOMAIN_LEVEL }, (_, i) => ({
                level: i + 1,
                power: domainPower(d, i + 1),
                text: d.text(domainPower(d, i + 1)),
                cost: i + 1 >= MAX_DOMAIN_LEVEL ? null : domainUpgradeCost(i + 1),
              })),
            },
          ])
        ),
        /**
         * Legendary skills, with every level precomputed. The copy lives in a
         * function on the server, so shipping the ladder rather than the
         * parameters is what stops the client growing its own second copy of
         * the wording that then drifts. Eight skills by five levels is a
         * trivial payload for a catalog fetched once.
         */
        skills: Object.fromEntries(
          Object.entries(SKILLS).map(([id, s]) => [
            id,
            {
              name: s.name,
              kind: s.kind,
              levels: Array.from({ length: MAX_SKILL_LEVEL }, (_, i) => ({
                level: i + 1,
                power: skillPower(s, i + 1),
                text: s.text(skillPower(s, i + 1)),
                cost: i + 1 >= MAX_SKILL_LEVEL ? null : skillUpgradeCost(i + 1, CARDS[id]?.rarity ?? "legendary"),
              })),
            },
          ])
        ),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Staff buy free everywhere else in the shop; cards match that. Reads the
// persistent role column first and self-heals from the username, so it survives
// a rename (see the identity rule).
async function isStaffFree(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, role: true } });
  if (!u) return false;
  const role = u.role && u.role !== "USER" ? u.role : getRole(u.username);
  return role === "LEAD_DEV" || role === "ADMIN";
}

// GET /api/cards/collectors — who owns what, ranked by completion. This is the
// "see other people's collections" board.
export const getCollectors = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const grouped = await prisma.userCard.groupBy({
      by: ["userId"],
      _count: { cardId: true },
      _sum: { count: true },
    });
    if (grouped.length === 0) return res.json({ success: true, data: [] });

    const users = await prisma.user.findMany({
      where: { id: { in: grouped.map((g) => g.userId) } },
      select: { id: true, username: true, avatar: true, cardTitle: true },
    });
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));

    const rows = grouped
      .filter((g) => byId[g.userId])
      .map((g) => ({
        userId: g.userId,
        username: byId[g.userId].username,
        avatar: byId[g.userId].avatar,
        cardTitle: byId[g.userId].cardTitle,
        distinct: g._count.cardId,
        total: g._sum.count || 0,
      }))
      .sort((a, b) => b.distinct - a.distinct || b.total - a.total)
      .slice(0, 50);

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
};

function ownerGuard(req: Request, res: Response, userId?: string): boolean {
  if (!userId) {
    res.status(400).json({ success: false, message: "Missing userId." });
    return false;
  }
  const actor = getActorId(req);
  if (actor && actor !== userId) {
    res.status(403).json({ success: false, message: "You can only manage your own collection." });
    return false;
  }
  return true;
}

// GET /api/cards/collection/:userId — owned cards (with counts) + shard balance.
// Public-ish: a collection is meant to be shown off, and it reveals nothing
// sensitive.
export const getCollection = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.userId as string;
    const [owned, user] = await Promise.all([
      prisma.userCard.findMany({ where: { userId }, select: { cardId: true, count: true, foil: true, hibernating: true, level: true, skillLevel: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { shards: true, claimedSets: true, cardTitle: true } }),
    ]);
    res.json({
      success: true,
      data: {
        cards: owned,
        shards: user?.shards ?? 0,
        claimedSets: user?.claimedSets ?? [],
        cardTitle: user?.cardTitle ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/cards/open-pack  body { userId }
export const openPack = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, count } = (req.body || {}) as { userId?: string; count?: number };
    if (!ownerGuard(req, res, userId)) return;

    /**
     * Pull size is chosen by the player. Only these three exist — a free-form
     * count would let a client ask for a hundred cards, and the PRICE has to
     * come from this table rather than from the request for the same reason.
     */
    const size = PULL_SIZES.includes(Number(count)) ? Number(count) : PACK_SIZE;
    const price = PULL_PRICES[size] ?? PACK_PRICE;

    const pulls = rollPack(size); // roll BEFORE the tx — pure, no I/O
    const free = await isStaffFree(userId!);

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Atomic AP debit: check + deduct in one op. count 0 = couldn't afford.
        if (!free) {
          const debit = await tx.user.updateMany({
            where: { id: userId, arisePoints: { gte: price } },
            data: { arisePoints: { decrement: price } },
          });
          if (debit.count === 0) throw new CardError(402, `That pull costs ${price.toLocaleString()} Arise Points — you don't have enough.`);
          await tx.pointLog.create({ data: { userId: userId!, amount: -price, reason: `card-pack:x${size}` } });
        }

        // Grant each pull — upsert the per-card count so dupes stack.
        for (const cardId of pulls) {
          await tx.userCard.upsert({
            where: { userId_cardId: { userId: userId!, cardId } },
            create: { userId: userId!, cardId, count: 1 },
            update: { count: { increment: 1 }, hibernating: false },
          });
        }

        const user = await tx.user.findUnique({ where: { id: userId }, select: { arisePoints: true } });
        return { arisePoints: user?.arisePoints ?? 0 };
      });

      res.json({ success: true, data: { pulls, arisePoints: result.arisePoints } });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};


// POST /api/cards/dust  body { userId, cardId }
// Convert the DUPLICATE copies of one card (everything past the first) into
// shards. Keeps one copy so the card stays in your collection.
export const dustCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId } = (req.body || {}) as { userId?: string; cardId?: string };
    if (!ownerGuard(req, res, userId)) return;

    const card = cardId ? CARDS[cardId] : undefined;
    if (!card) return res.status(400).json({ success: false, message: "Unknown card." });
    if (card.rarity === "event") return res.status(400).json({ success: false, message: "Event cards can't be dusted." });

    try {
      const result = await prisma.$transaction(async (tx) => {
        const owned = await tx.userCard.findUnique({ where: { userId_cardId: { userId: userId!, cardId: cardId! } } });
        if (!owned || owned.count <= 1) throw new CardError(400, "You have no duplicates of that card.");

        const dupes = owned.count - 1;
        const gained = dupes * DUST_VALUE[card.rarity];
        // Collapse to a single copy, mint the shards.
        await tx.userCard.update({ where: { userId_cardId: { userId: userId!, cardId: cardId! } }, data: { count: 1 } });
        const user = await tx.user.update({ where: { id: userId }, data: { shards: { increment: gained } }, select: { shards: true } });
        return { gained, shards: user.shards };
      });
      res.json({ success: true, data: result });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/cards/craft  body { userId, cardId }
// Spend shards to add a specific card (turns bad luck into a guaranteed path).
export const craftCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId } = (req.body || {}) as { userId?: string; cardId?: string };
    if (!ownerGuard(req, res, userId)) return;

    const card = cardId ? CARDS[cardId] : undefined;
    if (!card) return res.status(400).json({ success: false, message: "Unknown card." });
    const cost = CRAFT_COST[card.rarity];
    if (!cost || card.rarity === "event") return res.status(400).json({ success: false, message: "That card can't be crafted." });

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Atomic shard debit — same conditional-updateMany guard as AP.
        const debit = await tx.user.updateMany({
          where: { id: userId, shards: { gte: cost } },
          data: { shards: { decrement: cost } },
        });
        if (debit.count === 0) throw new CardError(402, `Crafting ${card.name} costs ${cost.toLocaleString()} shards — you don't have enough.`);

        await tx.userCard.upsert({
          where: { userId_cardId: { userId: userId!, cardId: cardId! } },
          create: { userId: userId!, cardId: cardId!, count: 1 },
          update: { count: { increment: 1 }, hibernating: false },
        });
        const user = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return { shards: user?.shards ?? 0 };
      });
      res.json({ success: true, data: { cardId, shards: result.shards } });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/cards/foil  body { userId, cardId }
// Spend shards to turn a card you own into its animated foil variant: it looks
// incredible AND fights 20% harder in duels (FOIL_MULT in duelRules).
export const foilCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId } = (req.body || {}) as { userId?: string; cardId?: string };
    if (!ownerGuard(req, res, userId)) return;

    const card = cardId ? CARDS[cardId] : undefined;
    if (!card) return res.status(400).json({ success: false, message: "Unknown card." });
    const cost = FOIL_COST[card.rarity];

    try {
      const result = await prisma.$transaction(async (tx) => {
        const owned = await tx.userCard.findUnique({ where: { userId_cardId: { userId: userId!, cardId: cardId! } } });
        if (!owned) throw new CardError(400, "You don't own that card.");
        if (owned.foil) throw new CardError(409, "That card is already foil.");

        const debit = await tx.user.updateMany({
          where: { id: userId, shards: { gte: cost } },
          data: { shards: { decrement: cost } },
        });
        if (debit.count === 0) throw new CardError(402, `Foiling ${card.name} costs ${cost.toLocaleString()} shards — you don't have enough.`);

        await tx.userCard.update({ where: { userId_cardId: { userId: userId!, cardId: cardId! } }, data: { foil: true } });
        const user = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return { shards: user?.shards ?? 0 };
      });
      res.json({ success: true, data: { cardId, foil: true, shards: result.shards } });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/cards/relic-pack  body { userId }
// A pack bought with SHARDS, guaranteed to contain at least one epic+. Lets a
// patient collector convert grinding into targeted luck.
export const openRelicPack = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req.body || {}) as { userId?: string };
    if (!ownerGuard(req, res, userId)) return;

    const pulls = rollRelicPack(PACK_SIZE);

    try {
      const result = await prisma.$transaction(async (tx) => {
        const debit = await tx.user.updateMany({
          where: { id: userId, shards: { gte: RELIC_PACK_SHARDS } },
          data: { shards: { decrement: RELIC_PACK_SHARDS } },
        });
        if (debit.count === 0) throw new CardError(402, `A relic pack costs ${RELIC_PACK_SHARDS.toLocaleString()} shards — you don't have enough.`);

        for (const cardId of pulls) {
          await tx.userCard.upsert({
            where: { userId_cardId: { userId: userId!, cardId } },
            create: { userId: userId!, cardId, count: 1 },
            update: { count: { increment: 1 }, hibernating: false },
          });
        }
        const user = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return { shards: user?.shards ?? 0 };
      });
      res.json({ success: true, data: { pulls, shards: result.shards } });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/cards/claim-set  body { userId, set }
// Completing a set pays out ONCE: Arise Points, shards, and a permanent title.
// This is the point of collecting — the payoff you can wear.
export const claimSet = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, set } = (req.body || {}) as { userId?: string; set?: string };
    if (!ownerGuard(req, res, userId)) return;

    const reward = set ? SET_REWARDS[set] : undefined;
    if (!reward) return res.status(400).json({ success: false, message: "Unknown set." });

    const required = cardsInSet(set!);

    try {
      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { claimedSets: true } });
        if (!user) throw new CardError(404, "User not found.");
        if ((user.claimedSets || []).includes(set!)) throw new CardError(409, "You've already claimed this set's reward.");

        const owned = await tx.userCard.findMany({ where: { userId, cardId: { in: required } }, select: { cardId: true } });
        if (owned.length < required.length) {
          throw new CardError(400, `You need all ${required.length} cards in ${set} — you have ${owned.length}.`);
        }

        // Guard the claim on claimedSets NOT already containing the set, so a
        // double-submit can't pay twice.
        const claim = await tx.user.updateMany({
          where: { id: userId, NOT: { claimedSets: { has: set! } } },
          data: {
            claimedSets: { push: set! },
            arisePoints: { increment: reward.ap },
            shards: { increment: reward.shards },
            cardTitle: reward.title,
          },
        });
        if (claim.count === 0) throw new CardError(409, "You've already claimed this set's reward.");

        await tx.pointLog.create({ data: { userId: userId!, amount: reward.ap, reason: `card-set:${set}` } });
        const fresh = await tx.user.findUnique({ where: { id: userId }, select: { arisePoints: true, shards: true } });
        return { arisePoints: fresh?.arisePoints ?? 0, shards: fresh?.shards ?? 0, title: reward.title };
      });
      res.json({ success: true, data: result });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

class CardError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

// ── GET /api/cards/ladder ─────────────────────────────────────────────────
// One board, three ways of being good at this place: how much you've watched
// (XP/level), how well you duel (Elo), and how deep your collection runs
// (distinct cards + shards). Keeping them in one response means the client can
// re-sort without three round trips, and nobody has to guess which board is
// "the real one".
export const getLadder = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [users, ratings, cardRows] = await Promise.all([
      prisma.user.findMany({
        where: { isPrivate: false },
        select: {
          id: true, username: true, avatar: true, xp: true, shards: true,
          cardTitle: true, role: true, isPrivate: true,
        },
        orderBy: { xp: "desc" },
        take: 200,
      }),
      prisma.duelRating.findMany({
        select: { userId: true, rating: true, wins: true, losses: true, streak: true },
      }),
      prisma.userCard.groupBy({ by: ["userId"], _count: { cardId: true } }),
    ]);

    const byRating = new Map(ratings.map((r) => [r.userId, r]));
    const byCards = new Map(cardRows.map((c) => [c.userId, c._count.cardId]));

    const rows = users.map((u) => {
      const r = byRating.get(u.id);
      return {
        userId: u.id,
        username: u.username,
        avatar: u.avatar,
        cardTitle: u.cardTitle,
        xp: u.xp,
        shards: u.shards,
        cards: byCards.get(u.id) || 0,
        rating: r?.rating ?? null,
        wins: r?.wins ?? 0,
        losses: r?.losses ?? 0,
        streak: r?.streak ?? 0,
      };
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
};

// ── PUT /api/cards/showcase ───────────────────────────────────────────────
// The three cards pinned to a profile. Ownership is checked server-side: a
// showcase is a claim about what you have, so it must not be possible to pin a
// card you have never pulled.
export const setShowcase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardIds } = (req.body || {}) as { userId?: string; cardIds?: string[] };
    if (!userId) return res.status(400).json({ success: false, message: "Missing userId." });
    const actor = getActorId(req);
    if (actor && actor !== userId) {
      return res.status(403).json({ success: false, message: "You can only change your own showcase." });
    }
    if (!Array.isArray(cardIds) || cardIds.length > 3) {
      return res.status(400).json({ success: false, message: "Pick up to three cards." });
    }
    const unique = [...new Set(cardIds)];
    if (unique.length) {
      const owned = await prisma.userCard.findMany({
        where: { userId, cardId: { in: unique } },
        select: { cardId: true },
      });
      if (owned.length !== unique.length) {
        return res.status(400).json({ success: false, message: "You can only showcase cards you own." });
      }
    }
    await prisma.user.update({ where: { id: userId }, data: { showcaseCards: { set: unique } } });
    res.json({ success: true, data: { showcaseCards: unique } });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/cards/wake  { userId, cardId } ──────────────────────────────
// Bring a hibernating card back with shards. A hibernating card is never
// deleted — losing with it puts it to sleep, and this is the fee to wake it.
export const wakeCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId } = (req.body || {}) as { userId?: string; cardId?: string };
    if (!userId || !cardId) return res.status(400).json({ success: false, message: "Missing userId or cardId." });
    const actor = getActorId(req);
    if (actor && actor !== userId) {
      return res.status(403).json({ success: false, message: "You can only wake your own cards." });
    }
    const def = CARDS[cardId];
    if (!def) return res.status(404).json({ success: false, message: "No such card." });

    const row = await prisma.userCard.findUnique({
      where: { userId_cardId: { userId, cardId } },
      select: { hibernating: true },
    });
    if (!row) return res.status(404).json({ success: false, message: "You don't own that card." });
    if (!row.hibernating) return res.status(400).json({ success: false, message: `${def.name} is already awake.` });

    const cost = WAKE_COST[def.rarity] ?? 0;

    try {
      const shards = await prisma.$transaction(async (tx) => {
        // Conditional decrement makes the check and the spend a single atomic
        // operation — two rapid clicks can't both pass an "enough shards" test.
        const paid = await tx.user.updateMany({
          where: { id: userId, shards: { gte: cost } },
          data: { shards: { decrement: cost } },
        });
        if (paid.count === 0) throw new Error("POOR");
        // Guarded on it still being asleep, so a double submit can't charge twice.
        const woke = await tx.userCard.updateMany({
          where: { userId, cardId, hibernating: true },
          data: { hibernating: false },
        });
        if (woke.count === 0) throw new Error("AWAKE");
        const u = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return u?.shards ?? 0;
      });
      res.json({ success: true, data: { shards, cardId, cost } });
    } catch (e: any) {
      if (e?.message === "POOR") {
        return res.status(402).json({ success: false, message: `Waking ${def.name} costs ${cost} shards.` });
      }
      if (e?.message === "AWAKE") {
        return res.status(400).json({ success: false, message: `${def.name} is already awake.` });
      }
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// ── POST /api/cards/upgrade  { userId, cardId } ───────────────────────────
// Spend shards to raise a card's level. Levels multiply ATK and HP in duels,
// so this is the sink that keeps shards meaningful once you own the set.
/**
 * POST /api/cards/upgrade-skill   body { userId, cardId }
 *
 * Level a LEGENDARY's skill with shards. Separate track from upgradeCard():
 * that raises ATK and HP, this raises the one thing the card uniquely does.
 *
 * Same money shape as every other spend in this file — a conditional
 * decrement so the affordability check and the spend are one operation, and a
 * level-guarded bump so two fast clicks can't buy two levels for the price of
 * the cheaper one.
 */
export const upgradeSkill = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId } = (req.body || {}) as { userId?: string; cardId?: string };
    if (!ownerGuard(req, res, userId)) return;
    if (!cardId) return res.status(400).json({ success: false, message: "Missing cardId." });

    const def = CARDS[cardId];
    if (!def) return res.status(404).json({ success: false, message: "No such card." });
    const skill = abilityFor(cardId);
    if (!skill) {
      return res.status(400).json({ success: false, message: `${def.name} has no ability to advance.` });
    }

    const row = await prisma.userCard.findUnique({
      where: { userId_cardId: { userId: userId!, cardId } },
      select: { skillLevel: true, hibernating: true },
    });
    if (!row) return res.status(404).json({ success: false, message: "You don't own that card." });
    if (row.hibernating) {
      return res.status(400).json({ success: false, message: `${def.name} is asleep. Wake it first.` });
    }

    const level = row.skillLevel || 1;
    if (level >= skill.max) {
      return res.status(400).json({ success: false, message: `${skill.def.name} is already at its ceiling.` });
    }
    // A domain is a different order of investment from a skill, so it prices
    // on its own curve rather than the rarity-keyed skill one.
    const cost = skill.type === "domain"
      ? domainUpgradeCost(level)
      : skillUpgradeCost(level, def.rarity);

    try {
      const out = await prisma.$transaction(async (tx) => {
        const paid = await tx.user.updateMany({
          where: { id: userId, shards: { gte: cost } },
          data: { shards: { decrement: cost } },
        });
        if (paid.count === 0) throw new CardError(402, `${skill.type === "domain" ? "Deepening" : "Training"} ${skill.def.name} costs ${cost.toLocaleString()} shards — you don't have enough.`);
        const bumped = await tx.userCard.updateMany({
          where: { userId, cardId, skillLevel: level },
          data: { skillLevel: { increment: 1 } },
        });
        if (bumped.count === 0) throw new CardError(409, "That ability is already advancing — try again in a moment.");
        const u = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return { shards: u?.shards ?? 0, skillLevel: level + 1 };
      });

      res.json({
        success: true,
        data: {
          ...out,
          cardId,
          abilityType: skill.type,
          skillName: skill.def.name,
          power: skill.type === "domain"
            ? domainPower(skill.def, out.skillLevel)
            : skillPower(skill.def, out.skillLevel),
          text: skill.def.text(
            skill.type === "domain"
              ? domainPower(skill.def, out.skillLevel)
              : skillPower(skill.def, out.skillLevel)
          ),
          nextCost: out.skillLevel >= skill.max
            ? null
            : skill.type === "domain"
              ? domainUpgradeCost(out.skillLevel)
              : skillUpgradeCost(out.skillLevel, def.rarity),
        },
      });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

export const upgradeCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId } = (req.body || {}) as { userId?: string; cardId?: string };
    if (!userId || !cardId) return res.status(400).json({ success: false, message: "Missing userId or cardId." });
    const actor = getActorId(req);
    if (actor && actor !== userId) {
      return res.status(403).json({ success: false, message: "You can only upgrade your own cards." });
    }
    const def = CARDS[cardId];
    if (!def) return res.status(404).json({ success: false, message: "No such card." });

    const row = await prisma.userCard.findUnique({
      where: { userId_cardId: { userId, cardId } },
      select: { level: true, hibernating: true },
    });
    if (!row) return res.status(404).json({ success: false, message: "You don't own that card." });
    if (row.hibernating) {
      return res.status(400).json({ success: false, message: `${def.name} is asleep. Wake it first.` });
    }

    const level = row.level || 1;
    if (level >= MAX_CARD_LEVEL) {
      return res.status(400).json({ success: false, message: `${def.name} is already at max level.` });
    }
    const cost = upgradeCost(def.rarity, level);

    try {
      const out = await prisma.$transaction(async (tx) => {
        // One conditional decrement makes the affordability check and the spend
        // a single operation — two fast clicks can't both pass.
        const paid = await tx.user.updateMany({
          where: { id: userId, shards: { gte: cost } },
          data: { shards: { decrement: cost } },
        });
        if (paid.count === 0) throw new Error("POOR");
        // Guarded on the level we priced, so a double submit can't buy two
        // levels for the price of the cheaper one.
        const bumped = await tx.userCard.updateMany({
          where: { userId, cardId, level },
          data: { level: { increment: 1 } },
        });
        if (bumped.count === 0) throw new Error("RACE");
        const u = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return { shards: u?.shards ?? 0, level: level + 1 };
      });
      res.json({
        success: true,
        data: {
          ...out,
          cardId,
          spent: cost,
          nextCost: out.level >= MAX_CARD_LEVEL ? null : upgradeCost(def.rarity, out.level),
        },
      });
    } catch (e: any) {
      if (e?.message === "POOR") {
        return res.status(402).json({ success: false, message: `Levelling ${def.name} costs ${cost} shards.` });
      }
      if (e?.message === "RACE") {
        return res.status(409).json({ success: false, message: "That upgrade already went through." });
      }
      throw e;
    }
  } catch (error) {
    next(error);
  }
};
