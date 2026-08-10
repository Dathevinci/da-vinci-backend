import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { heldCardIds } from "../lib/showcase";
import { getRole } from "../utils/economy";
import { CARD_STATS, CARD_STATS_BY_ID, FOIL_MULT, rollStats, printedStats } from "../data/duelRules";
import {
  CARDS,
  PACK_PRICE,
  PACK_SIZE,
  PULL_SIZES,
  PULL_PRICES,
  RARITY_WEIGHTS,
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
  FORGE_MAX,
  FORGE_ATK_STEP,
  FORGE_HP_STEP,
  forgeCost,
  FUSIONS,
  FUSION_ELIGIBLE,
  SYNTH_COST_AP,
  SYNTH_COST_SHARDS,
  SYNTH_BASE_CHANCE,
  SYNTH_BOOST_STEP,
  MYTHIC_AFFIXES,
  MYTHIC_MODS,
  MERGE_MAX,
  MERGE_STEP,
  mergeCost,
} from "../data/cardCatalog";
import {
  mintPrints,
  burnWorstPrints,
  findDuplicatePrints,
  isLegendary,
  CONDITION_META,
  type PrintInfo,
} from "../lib/prints";

/**
 * PULLS ARE CLOSED for the card rework.
 *
 * Every path that MINTS a random card is refused: normal packs and relic
 * packs alike. Enforced server-side rather than by hiding the buttons,
 * because a hidden button is not a closed door — and a pack rolled from a
 * catalogue mid-rework would mint cards that are about to stop existing.
 *
 * Nothing else is affected: dusting, crafting, trading, duelling and the
 * workbench all keep working on what people already own. Flip this to false
 * to reopen.
 */
const PULLS_CLOSED = false;

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
        // The forge, priced per rarity per rank so the client can show the
        // exact bill: cost[rank] is what the NEXT rank from `rank` costs.
        forge: {
          max: FORGE_MAX,
          atkStep: FORGE_ATK_STEP,
          hpStep: FORGE_HP_STEP,
          atkCost: Object.fromEntries((["common", "rare", "epic", "legendary", "event"] as const)
            .map((r) => [r, Array.from({ length: FORGE_MAX }, (_, i) => forgeCost("atk", r, i))])),
          hpCost: Object.fromEntries((["common", "rare", "epic", "legendary", "event"] as const)
            .map((r) => [r, Array.from({ length: FORGE_MAX }, (_, i) => forgeCost("hp", r, i))])),
        },
        /**
         * THE REAL PULL ODDS, as percentages derived from RARITY_WEIGHTS.
         *
         * Served here because the banner paints before /pull-stats resolves,
         * and it was filling that gap with hardcoded literals — which drifted
         * the moment the odds were retuned. The page advertised 0.6/8/27.4/64
         * while the server rolled 0.4/4.6/17/78. Misstated odds on the screen
         * where players spend currency is the one number in this product that
         * has to come from the same place the roll does.
         */
        pullRates: (() => {
          const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
          return Object.fromEntries(
            Object.entries(RARITY_WEIGHTS).map(([r, w]) => [r, Number(((w / total) * 100).toFixed(2))])
          );
        })(),
        relicPackShards: RELIC_PACK_SHARDS,
        /**
         * MERGING — feed a spare of the same rank in to raise a copy's roll.
         * The whole cost ladder ships so the button can name the price before
         * the finger commits, and so the client never grows its own copy of
         * the doubling curve to drift out of step with mergeCost().
         */
        merge: {
          max: MERGE_MAX,
          step: MERGE_STEP,
          cost: Object.fromEntries((["common", "rare", "epic", "legendary", "event", "mythic"] as const)
            .map((r) => [r, Array.from({ length: MERGE_MAX }, (_, i) => mergeCost(r, i))])),
        },
        setRewards: SET_REWARDS,
        // Combat stats ship with the catalog so the UI can show what a card
        // DOES without duplicating the table and letting it drift.
        cardStats: CARD_STATS,
        /**
         * PER-CARD stats, which outrank the rarity table above.
         *
         * The Knight set is authored card by card — the Squire is 9/4 and the
         * Jester 13/1, numbers a rarity table cannot express. Without this the
         * client fell back to the common line for both and displayed 18/7 on
         * every Knight, so the face advertised stats no fight would ever use.
         */
        cardStatsById: CARD_STATS_BY_ID,
        foilMult: FOIL_MULT,
        maxSkillLevel: MAX_SKILL_LEVEL,
        maxDomainLevel: MAX_DOMAIN_LEVEL,
        // Legendary print conditions — labels + mint odds, served so the
        // client never grows its own copy of either.
        printConditions: CONDITION_META,
        // The Synthesis Lab's whole rulebook, served so the client can only
        // ever OFFER what the machine will accept.
        // RETIRED with the card wipe. Served as empty rather than dropped so
        // an older cached client still parses it — the forge page guards
        // every read behind `synth?.`, so an empty rulebook simply offers
        // nothing to fuse instead of throwing.
        synthesis: {
          eligible: [] as string[],
          fusions: {} as Record<string, string>,
          ap: SYNTH_COST_AP,
          shards: SYNTH_COST_SHARDS,
          baseChance: SYNTH_BASE_CHANCE,
          boostStep: SYNTH_BOOST_STEP,
          affixes: MYTHIC_AFFIXES,
          mods: MYTHIC_MODS,
        },
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

/**
 * The LEAD DEV's shard spends are free — that account exists to test every
 * sink (craft, foil, relic packs, wake, levels, skills, duel items) without
 * grinding dust first. LEAD DEV ONLY, deliberately narrower than
 * isStaffFree: admins play the real economy. Same role-column-first,
 * username-fallback shape as everything else (the identity rule).
 */
export async function isLeadDevFree(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, role: true } });
  if (!u) return false;
  const role = u.role && u.role !== "USER" ? u.role : getRole(u.username);
  return role === "LEAD_DEV";
}

// GET /api/cards/pull-stats?userId=... — how many packs have been opened
// (community-wide and by you) plus the printed odds. Counts come from the
// pointLog spend rows (`card-pack:xN`), which means free staff pulls don't
// inflate the numbers — these are real, paid pulls.
export const getPullStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req.query.userId as string) || "";
    // TWO reason formats live in the log: launch-day packs wrote a plain
    // "card-pack" (always the standard 4-card pack), the pull-size update
    // writes "card-pack:xN". Matching only the new one silently erased
    // every launch-week pull — the owner's friend hand-counted 2,410 spins
    // while this endpoint reported 186. startsWith catches both eras.
    const tally = async (who?: string) => {
      const rows = await prisma.pointLog.groupBy({
        by: ["reason"],
        where: { ...(who ? { userId: who } : {}), reason: { startsWith: "card-pack" } },
        _count: { _all: true },
        _sum: { amount: true },
      });
      let packs = 0, cards = 0, apSpent = 0;
      for (const r of rows) {
        const m = /^card-pack:x(\d+)$/.exec(r.reason);
        const size = m ? Number(m[1]) : PACK_SIZE;
        packs += r._count._all;
        cards += r._count._all * size;
        apSpent += -(r._sum.amount || 0);
      }
      return { packs, cards, apSpent };
    };
    const [community, mine] = await Promise.all([
      tally(),
      userId ? tally(userId) : Promise.resolve({ packs: 0, cards: 0, apSpent: 0 }),
    ]);
    // Percentages derived from the live weights, never hand-copied — if the
    // squeeze ever moves again, this endpoint moves with it.
    const totalW = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
    const rates = Object.fromEntries(Object.entries(RARITY_WEIGHTS)
      .map(([k, w]) => [k, Number(((w / totalW) * 100).toFixed(2))]));
    res.json({
      success: true,
      data: {
        community,
        mine,
        rates,
        pullSizes: PULL_SIZES,
        legendaryWears: Object.fromEntries(Object.entries(CONDITION_META)
          .map(([k, m]) => [k, { label: m.label, pct: m.weight }])),
      },
    });
  } catch (error) { next(error); }
};

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
    const [owned, user, prints] = await Promise.all([
      // rolledHp/rolledAtk/merges ride along so the binder can show what THIS
      // copy actually is. Without them every surface fell back to the printed
      // line and the pull roll was invisible outside a duel — which read, from
      // the outside, exactly like the randomisation never shipped.
      prisma.userCard.findMany({ where: { userId }, select: { cardId: true, count: true, foil: true, hibernating: true, level: true, skillLevel: true, atkForge: true, hpForge: true, mythAffix: true, mythMod: true, rolledHp: true, rolledAtk: true, merges: true, raidRestUntil: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { shards: true, claimedSets: true, cardTitle: true } }),
      // Legendary print identities — serial + condition per held copy. Best
      // condition first, then oldest serial, so the first entry is always
      // the copy a collector would lead with.
      prisma.cardPrint.findMany({
        where: { userId },
        select: { cardId: true, serial: true, condition: true },
        orderBy: { serial: "asc" },
      }),
    ]);
    const printMap: Record<string, { serial: number; condition: string }[]> = {};
    for (const p of prints) (printMap[p.cardId] ||= []).push({ serial: p.serial, condition: p.condition });
    // The orderBy above is serial-only; finish the promised ordering here.
    const rank: Record<string, number> = { fresh: 2, rusted: 1, factory: 0 };
    for (const list of Object.values(printMap)) {
      list.sort((a, b) => (rank[b.condition] ?? 0) - (rank[a.condition] ?? 0) || a.serial - b.serial);
    }
    res.json({
      success: true,
      data: {
        cards: owned.map((c) => ({ ...c, prints: printMap[c.cardId] || undefined })),
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

    // PULLS ARE CLOSED for the card rework. Refused here, at the top, before
    // any AP is touched — the client is not the gate, and a pack rolled from
    // a catalogue mid-rework would mint cards that are about to stop existing.
    if (PULLS_CLOSED) {
      return res.status(503).json({
        success: false,
        message: "Pulls are closed while the card game is reworked. Your Arise Points are safe.",
      });
    }

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
        } else {
          // Free staff pulls still log — amount 0, so AP-spent stays honest
          // while the pull COUNTERS see every pack. Without this the owner's
          // own stats read a lifetime of zero.
          await tx.pointLog.create({ data: { userId: userId!, amount: 0, reason: `card-pack:x${size}` } });
        }

        // Grant each pull — upsert the per-card count so dupes stack.
        // Every LEGENDARY copy also mints a print: its serial and condition
        // are born here, inside the same transaction as the grant, so a
        // failed grant can never leave an orphan print (or vice versa).
        const prints: PrintInfo[] = [];
        for (const cardId of pulls) {
          // The roll is taken ONCE, on the copy that first opens this card.
          // A duplicate increments the count and leaves the roll alone —
          // re-rolling every dupe would quietly erase a good roll the owner
          // had already sunk shards into.
          const roll = rollStats(CARDS[cardId]);
          await tx.userCard.upsert({
            where: { userId_cardId: { userId: userId!, cardId } },
            create: {
              userId: userId!, cardId, count: 1,
              rolledHp: roll?.hp ?? null, rolledAtk: roll?.atk ?? null,
            },
            update: { count: { increment: 1 }, hibernating: false },
          });
          if (isLegendary(cardId)) prints.push(...(await mintPrints(tx, userId!, cardId, 1)));
        }

        const user = await tx.user.findUnique({ where: { id: userId }, select: { arisePoints: true } });
        return { arisePoints: user?.arisePoints ?? 0, prints };
      }, { timeout: 30000 }); // a x32 is 32 upserts and up to 32 print mints — the default 5s is too tight

      res.json({ success: true, data: { pulls, prints: result.prints, arisePoints: result.arisePoints } });
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

        let dupes: number;
        if (isLegendary(cardId!)) {
          // WEAR-AWARE: a Fresh Build and a Factory New are different
          // objects, not duplicates of each other. Only same-build extras
          // dust; the best serial of every build survives. Two copies in two
          // different builds = zero dupes, and the dust is refused.
          const extras = await findDuplicatePrints(tx, userId!, cardId!);
          if (extras.length === 0) {
            throw new CardError(400, "Different builds aren't duplicates — every copy you hold is its own wear.");
          }
          dupes = extras.length;
          // Guarded decrement, same race-of-record rule as the collapse below.
          const taken = await tx.userCard.updateMany({
            where: { userId, cardId, count: owned.count },
            data: { count: { decrement: dupes } },
          });
          if (taken.count === 0) throw new CardError(409, "Your copies just changed — try again.");
          await tx.cardPrint.deleteMany({ where: { id: { in: extras } } });
        } else {
          dupes = owned.count - 1;
          // Collapse to a single copy, GUARDED on the count still being what
          // we read — the unconditional write was a latent race (double-dust
          // paid twice; a pack landing mid-dust got clobbered).
          const collapsed = await tx.userCard.updateMany({
            where: { userId, cardId, count: owned.count },
            data: { count: 1 },
          });
          if (collapsed.count === 0) throw new CardError(409, "Your copies just changed — try again.");
        }
        const gained = dupes * DUST_VALUE[card.rarity];
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

// POST /api/cards/max  body { userId, cardId, dryRun? }
// ONE bill for everything a card has left: levels to 10, both forge ranks
// to 5 (fighters), and its skill or domain to cap. dryRun prices it without
// spending, so the button can say the number before the finger commits.
export const maxCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId, dryRun } = (req.body || {}) as { userId?: string; cardId?: string; dryRun?: boolean };
    if (!ownerGuard(req, res, userId)) return;
    const card = cardId ? CARDS[cardId] : undefined;
    if (!card) return res.status(400).json({ success: false, message: "Unknown card." });

    const row = await prisma.userCard.findUnique({ where: { userId_cardId: { userId: userId!, cardId: cardId! } } });
    if (!row || row.count < 1) return res.status(400).json({ success: false, message: "You don't own that card." });

    const curLevel = row.level || 1;
    const curSkill = row.skillLevel || 1;
    const curAtk = (row as any).atkForge || 0;
    const curHp = (row as any).hpForge || 0;

    // What's left, and what it costs — same formulas as the single steps.
    let cost = 0;
    for (let l = curLevel; l < MAX_CARD_LEVEL; l++) cost += upgradeCost(card.rarity, l);
    // Same rule as forgeCard: grounds are never fielded, so their forge ranks
    // are read by nothing. Without this the max-out bill quoted and charged a
    // ground for all ten ranks in a single click.
    const forgeable = !card.support && !card.ground;
    if (forgeable) {
      for (let r = curAtk; r < FORGE_MAX; r++) cost += forgeCost("atk", card.rarity, r);
      for (let r = curHp; r < FORGE_MAX; r++) cost += forgeCost("hp", card.rarity, r);
    }
    const isDom = !!DOMAINS[cardId!];
    const skillDef = SKILLS[cardId!];
    const skillCap = isDom ? MAX_DOMAIN_LEVEL : skillDef ? MAX_SKILL_LEVEL : curSkill;
    for (let s = curSkill; s < skillCap; s++) cost += isDom ? domainUpgradeCost(s) : skillUpgradeCost(s, card.rarity);

    const targetAtk = forgeable ? FORGE_MAX : curAtk;
    const targetHp = forgeable ? FORGE_MAX : curHp;
    const already = curLevel >= MAX_CARD_LEVEL && curAtk >= targetAtk && curHp >= targetHp && curSkill >= skillCap;
    if (already) return res.status(400).json({ success: false, message: "Every dial is already at the top." });

    if (dryRun) {
      return res.json({ success: true, data: { cost, level: MAX_CARD_LEVEL, atkForge: targetAtk, hpForge: targetHp, skillLevel: skillCap } });
    }

    const free = await isLeadDevFree(userId!);
    try {
      const result = await prisma.$transaction(async (tx) => {
        if (!free) {
          const debit = await tx.user.updateMany({
            where: { id: userId, shards: { gte: cost } },
            data: { shards: { decrement: cost } },
          });
          if (debit.count === 0) throw new CardError(402, `Maxing this card costs ${cost.toLocaleString()} shards.`);
        }
        // Guarded on the EXACT dials we priced — two fast presses can't buy
        // the same climb twice, and a mid-flight single upgrade aborts this.
        const bump = await tx.userCard.updateMany({
          where: { userId, cardId, level: curLevel, skillLevel: curSkill, atkForge: curAtk, hpForge: curHp },
          data: { level: MAX_CARD_LEVEL, skillLevel: skillCap, atkForge: targetAtk, hpForge: targetHp },
        });
        if (bump.count === 0) throw new CardError(409, "The card just changed — try again.");
        const u = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return { cost, shards: u?.shards ?? 0, level: MAX_CARD_LEVEL, atkForge: targetAtk, hpForge: targetHp, skillLevel: skillCap };
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


// POST /api/cards/grant-all  body { userId } — LEAD DEV ONLY.
// One copy of every catalog card the account doesn't already hold, prints
// minted for the legendaries in the same transaction (the invariant that
// keeps serials honest). Idempotent: owned cards are skipped, so a second
// press grants nothing and inflates nothing.
export const grantAllCards = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req.body || {}) as { userId?: string };
    if (!ownerGuard(req, res, userId)) return;
    // Role-column gate, never the username — the whole catalog is an owner
    // tool, not a purchasable.
    if (!(await isLeadDevFree(userId!))) {
      return res.status(403).json({ success: false, message: "The full catalog belongs to the lead dev alone." });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const owned = await tx.userCard.findMany({ where: { userId }, select: { cardId: true } });
        const have = new Set(owned.map((o) => o.cardId));
        // Mythics are NEVER granted — not by packs, not by the catalog claim.
        // Synthesis is the only door, even for the lead dev.
        const missing = Object.keys(CARDS).filter((id) => !have.has(id) && CARDS[id].rarity !== "mythic");
        const prints: PrintInfo[] = [];
        for (const cardId of missing) {
          await tx.userCard.upsert({
            where: { userId_cardId: { userId: userId!, cardId } },
            create: { userId: userId!, cardId, count: 1 },
            update: { count: { increment: 1 }, hibernating: false },
          });
          if (isLegendary(cardId)) prints.push(...(await mintPrints(tx, userId!, cardId, 1)));
        }
        return { granted: missing.length, prints };
      }, { timeout: 30000 }); // one write per missing card; a fresh account is the whole catalog
      res.json({ success: true, data: result });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

// POST /api/cards/dust-all  body { userId }
// The whole binder in ONE sweep: keep one copy of every card (and the best
// serial of EVERY build of every legendary), dust the rest. Same rules as
// dustCard per card — events never dust, different builds are never dupes —
// with per-card guarded writes so a pack landing mid-sweep aborts cleanly
// instead of being eaten.
export const dustAllDupes = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req.body || {}) as { userId?: string };
    if (!ownerGuard(req, res, userId)) return;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const rows = await tx.userCard.findMany({ where: { userId, count: { gt: 1 } } });
        let copies = 0, gained = 0;
        for (const owned of rows) {
          const card = CARDS[owned.cardId];
          if (!card || card.rarity === "event") continue;
          let dupes = 0;
          if (isLegendary(owned.cardId)) {
            const extras = await findDuplicatePrints(tx, userId!, owned.cardId);
            if (extras.length === 0) continue;
            dupes = extras.length;
            const taken = await tx.userCard.updateMany({
              where: { userId, cardId: owned.cardId, count: owned.count },
              data: { count: { decrement: dupes } },
            });
            if (taken.count === 0) throw new CardError(409, "Your collection just changed — try again.");
            await tx.cardPrint.deleteMany({ where: { id: { in: extras } } });
          } else {
            dupes = owned.count - 1;
            const collapsed = await tx.userCard.updateMany({
              where: { userId, cardId: owned.cardId, count: owned.count },
              data: { count: 1 },
            });
            if (collapsed.count === 0) throw new CardError(409, "Your collection just changed — try again.");
          }
          copies += dupes;
          gained += dupes * DUST_VALUE[card.rarity];
        }
        if (copies === 0) throw new CardError(400, "No duplicates to dust — every copy you hold is one of a kind.");
        const user = await tx.user.update({ where: { id: userId }, data: { shards: { increment: gained } }, select: { shards: true } });
        return { copies, gained, shards: user.shards };
      }, { timeout: 20000 }); // a big binder is many guarded writes; the default 5s is too tight for the free-tier DB
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

    const free = await isLeadDevFree(userId!);
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Atomic shard debit — same conditional-updateMany guard as AP.
        // The lead dev skips it entirely, same shape as openPack's staff-free.
        if (!free) {
          const debit = await tx.user.updateMany({
            where: { id: userId, shards: { gte: cost } },
            data: { shards: { decrement: cost } },
          });
          if (debit.count === 0) throw new CardError(402, `Crafting ${card.name} costs ${cost.toLocaleString()} shards — you don't have enough.`);
        }

        await tx.userCard.upsert({
          where: { userId_cardId: { userId: userId!, cardId: cardId! } },
          create: { userId: userId!, cardId: cardId!, count: 1 },
          update: { count: { increment: 1 }, hibernating: false },
        });
        // A crafted legendary is a real copy — it gets a print like any other.
        const prints = isLegendary(cardId!) ? await mintPrints(tx, userId!, cardId!, 1) : [];
        const user = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return { shards: user?.shards ?? 0, prints };
      });
      res.json({ success: true, data: { cardId, prints: result.prints, shards: result.shards } });
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

        if (!(await isLeadDevFree(userId!))) {
          const debit = await tx.user.updateMany({
            where: { id: userId, shards: { gte: cost } },
            data: { shards: { decrement: cost } },
          });
          if (debit.count === 0) throw new CardError(402, `Foiling ${card.name} costs ${cost.toLocaleString()} shards — you don't have enough.`);
        }

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

    // A relic pack is a pull too — and its guaranteed-rarity roll indexes a
    // filtered pool, which throws outright once that rarity is emptied.
    if (PULLS_CLOSED) {
      return res.status(503).json({
        success: false,
        message: "Relic packs are closed while the card game is reworked. Your shards are safe.",
      });
    }

    const pulls = rollRelicPack(PACK_SIZE);

    const free = await isLeadDevFree(userId!);
    try {
      const result = await prisma.$transaction(async (tx) => {
        if (!free) {
          const debit = await tx.user.updateMany({
            where: { id: userId, shards: { gte: RELIC_PACK_SHARDS } },
            data: { shards: { decrement: RELIC_PACK_SHARDS } },
          });
          if (debit.count === 0) throw new CardError(402, `A relic pack costs ${RELIC_PACK_SHARDS.toLocaleString()} shards — you don't have enough.`);
        }

        const prints: PrintInfo[] = [];
        for (const cardId of pulls) {
          // The roll is taken ONCE, on the copy that first opens this card.
          // A duplicate increments the count and leaves the roll alone —
          // re-rolling every dupe would quietly erase a good roll the owner
          // had already sunk shards into.
          const roll = rollStats(CARDS[cardId]);
          await tx.userCard.upsert({
            where: { userId_cardId: { userId: userId!, cardId } },
            create: {
              userId: userId!, cardId, count: 1,
              rolledHp: roll?.hp ?? null, rolledAtk: roll?.atk ?? null,
            },
            update: { count: { increment: 1 }, hibernating: false },
          });
          if (isLegendary(cardId)) prints.push(...(await mintPrints(tx, userId!, cardId, 1)));
        }
        const user = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return { shards: user?.shards ?? 0, prints };
      });
      res.json({ success: true, data: { pulls, prints: result.prints, shards: result.shards } });
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

        // A set whose cards were retired has an EMPTY required list, and
        // `0 < 0` is false — so the gate below would swing OPEN and pay the
        // full reward to anyone who asked. Across the retired sets that was
        // 46,000 AP and 9,200 shards claimable per user. Refuse outright.
        if (required.length === 0) {
          throw new CardError(410, "That set was retired while the card game is reworked.");
        }
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
        // Shipped so the client can tell staff from players by the PERSISTENT
        // role rather than a hardcoded username list — staff sit outside the
        // level ladder, and a username check would break the moment one of
        // them renames.
        role: u.role,
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
// The cards pinned to a profile — up to four. Ownership is checked
// server-side: a showcase is a claim about what you have, so it must not be
// possible to pin a card you have never pulled.
// ── TITLES ── set-completion titles you can WEAR, stacked up to three.
// GET /api/cards/titles/:userId — everything owned plus what's equipped.
// Ownership is DERIVED from claimedSets each read, never stored twice.
export const getTitles = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.userId as string;
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { claimedSets: true, cardTitle: true, equippedTitles: true },
    });
    if (!u) return res.status(404).json({ success: false, message: "User not found." });
    const owned = (u.claimedSets || [])
      .map((s: string) => ({ set: s, title: SET_REWARDS[s]?.title }))
      .filter((x): x is { set: string; title: string } => !!x.title);
    // Legacy: a cardTitle from before this system stays wearable even if its
    // set somehow isn't in claimedSets.
    if (u.cardTitle && !owned.some((o) => o.title === u.cardTitle)) {
      owned.push({ set: "", title: u.cardTitle });
    }
    res.json({ success: true, data: { owned, equipped: u.equippedTitles || [] } });
  } catch (error) { next(error); }
};

// PUT /api/cards/titles  body { userId, titles: string[] } — equip a stack.
// The ORDER is the wearer's choice; ownership and the cap are the server's.
export const setTitles = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, titles } = (req.body || {}) as { userId?: string; titles?: string[] };
    if (!userId) return res.status(400).json({ success: false, message: "Missing userId." });
    const actor = getActorId(req);
    if (actor && actor !== userId) {
      return res.status(403).json({ success: false, message: "You can only change your own titles." });
    }
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { claimedSets: true, cardTitle: true } });
    if (!u) return res.status(404).json({ success: false, message: "User not found." });
    const ownable = new Set((u.claimedSets || []).map((s) => SET_REWARDS[s]?.title).filter(Boolean));
    if (u.cardTitle) ownable.add(u.cardTitle);
    const chosen = [...new Set((Array.isArray(titles) ? titles : [])
      .filter((t) => typeof t === "string" && ownable.has(t)))].slice(0, 3);
    await prisma.user.update({ where: { id: userId }, data: { equippedTitles: chosen } });
    res.json({ success: true, data: { equipped: chosen } });
  } catch (error) { next(error); }
};

export const setShowcase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardIds } = (req.body || {}) as { userId?: string; cardIds?: string[] };
    if (!userId) return res.status(400).json({ success: false, message: "Missing userId." });
    const actor = getActorId(req);
    if (actor && actor !== userId) {
      return res.status(403).json({ success: false, message: "You can only change your own showcase." });
    }
    if (!Array.isArray(cardIds) || cardIds.length > 4) {
      return res.status(400).json({ success: false, message: "Pick up to four cards." });
    }
    // Same definition of "yours" the profile read uses — a card escrowed in
    // your own ACTIVE listing is still pinnable, or listing a showcased card
    // would blank it AND brick every later save.
    const unique = [...new Set(cardIds)].filter((id) => typeof id === "string" && id.length > 0 && id.length < 64);
    if (unique.length) {
      const held = await heldCardIds(userId, unique);
      if (held.size !== unique.length) {
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
    const free = await isLeadDevFree(userId!);

    try {
      const shards = await prisma.$transaction(async (tx) => {
        // Conditional decrement makes the check and the spend a single atomic
        // operation — two rapid clicks can't both pass an "enough shards" test.
        if (!free) {
          const paid = await tx.user.updateMany({
            where: { id: userId, shards: { gte: cost } },
            data: { shards: { decrement: cost } },
          });
          if (paid.count === 0) throw new Error("POOR");
        }
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

// ── POST /api/cards/forge  { userId, cardId, stat: "atk" | "hp" } ──────────
// The forge: flat stat training, one stat at a time, priced to hurt (cost
// doubles per rank, scaled by rarity). Same house rules as every other
// spend: atomic conditional debit, rank-guarded bump so a double-submit
// can't buy two ranks for one price, lead dev forges free.
export const forgeCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId, stat } = (req.body || {}) as { userId?: string; cardId?: string; stat?: string };
    if (!ownerGuard(req, res, userId)) return;
    if (stat !== "atk" && stat !== "hp") {
      return res.status(400).json({ success: false, message: "Forge ATK or HP — nothing else fits on the anvil." });
    }
    const card = cardId ? CARDS[cardId] : undefined;
    if (!card) return res.status(404).json({ success: false, message: "No such card." });
    // Grounds are refused alongside supports. buildFighter returns null for
    // both, so their forge ranks are read by nothing, anywhere — a forged
    // ground was a pure shard sink that bought provably zero effect in any
    // mode. A ground's only real scaling lever is its LEVEL, which the engine
    // does apply when the ground is laid.
    if (card.support || card.ground) {
      return res.status(400).json({
        success: false,
        message: `${card.name} is never fielded — there's no stat line on the anvil to hammer.`,
      });
    }

    const owned = await prisma.userCard.findUnique({ where: { userId_cardId: { userId: userId!, cardId: cardId! } } });
    if (!owned) return res.status(400).json({ success: false, message: "You don't own that card." });
    const rank = stat === "atk" ? ((owned as any).atkForge || 0) : ((owned as any).hpForge || 0);
    if (rank >= FORGE_MAX) {
      return res.status(400).json({ success: false, message: `${card.name}'s ${stat.toUpperCase()} is fully forged.` });
    }
    const cost = forgeCost(stat, card.rarity, rank);
    const free = await isLeadDevFree(userId!);

    try {
      const result = await prisma.$transaction(async (tx) => {
        if (!free) {
          const debit = await tx.user.updateMany({
            where: { id: userId, shards: { gte: cost } },
            data: { shards: { decrement: cost } },
          });
          if (debit.count === 0) throw new CardError(402, `This forge rank costs ${cost.toLocaleString()} shards — you don't have enough.`);
        }
        // Guarded on the rank still being what we read — the same shape as
        // the level and skill bumps, for the same double-submit reason.
        const bump = stat === "atk"
          ? await tx.userCard.updateMany({ where: { userId, cardId, atkForge: rank }, data: { atkForge: { increment: 1 } } })
          : await tx.userCard.updateMany({ where: { userId, cardId, hpForge: rank }, data: { hpForge: { increment: 1 } } });
        if (bump.count === 0) throw new CardError(409, "That forge just landed — try again in a moment.");
        const u = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return { shards: u?.shards ?? 0 };
      });
      const newRank = rank + 1;
      res.json({
        success: true,
        data: {
          ...result,
          stat,
          rank: newRank,
          nextCost: newRank >= FORGE_MAX ? null : forgeCost(stat, card.rarity, newRank),
        },
      });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) { next(error); }
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

    const free = await isLeadDevFree(userId!);
    try {
      const out = await prisma.$transaction(async (tx) => {
        if (!free) {
          const paid = await tx.user.updateMany({
            where: { id: userId, shards: { gte: cost } },
            data: { shards: { decrement: cost } },
          });
          if (paid.count === 0) throw new CardError(402, `${skill.type === "domain" ? "Deepening" : "Training"} ${skill.def.name} costs ${cost.toLocaleString()} shards — you don't have enough.`);
        }
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

/**
 * POST /api/cards/attune   body { userId, cardId }
 *
 * Spend a DUPLICATE copy to advance that card's skill or domain one rank,
 * paying no shards at all.
 *
 * This is the answer to what extra copies are for. Dusting was the only thing
 * to do with them, which meant every duplicate of a card you actually play was
 * worth the same as a duplicate of one you don't — a flat rate that quietly
 * punished pulling the card you were chasing. Now a spare copy of something
 * you fight with feeds the thing that makes it worth fighting with, and dust
 * remains the right answer for everything else.
 *
 * Deliberately NOT a shortcut past the ceiling: the rank cap still applies, so
 * this changes what a duplicate is worth, never how strong a card can get.
 */
export const attuneCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId } = (req.body || {}) as { userId?: string; cardId?: string };
    if (!ownerGuard(req, res, userId)) return;
    if (!cardId) return res.status(400).json({ success: false, message: "Missing cardId." });

    const def = CARDS[cardId];
    if (!def) return res.status(404).json({ success: false, message: "No such card." });
    const ability = abilityFor(cardId);
    if (!ability) {
      return res.status(400).json({ success: false, message: `${def.name} has no ability to advance.` });
    }

    const row = await prisma.userCard.findUnique({
      where: { userId_cardId: { userId: userId!, cardId } },
      select: { count: true, skillLevel: true, hibernating: true },
    });
    if (!row) return res.status(404).json({ success: false, message: "You don't own that card." });
    if (row.hibernating) {
      return res.status(400).json({ success: false, message: `${def.name} is asleep. Wake it first.` });
    }
    if (row.count < 2) {
      return res.status(400).json({ success: false, message: `You need a spare copy of ${def.name} to attune it.` });
    }
    const level = row.skillLevel || 1;
    if (level >= ability.max) {
      return res.status(400).json({ success: false, message: `${ability.def.name} is already at its ceiling.` });
    }

    try {
      const out = await prisma.$transaction(async (tx) => {
        // Both guards are conditional and in one op each, so two fast clicks
        // can't consume one copy twice or buy two ranks off a single spare.
        const spent = await tx.userCard.updateMany({
          where: { userId, cardId, count: { gte: 2 }, skillLevel: level },
          data: { count: { decrement: 1 }, skillLevel: { increment: 1 } },
        });
        if (spent.count === 0) throw new CardError(409, "That copy is already being attuned — try again in a moment.");
        // The consumed copy was a real print: burn the worst one held, so
        // attuning never eats a Fresh Build while a Factory New sits there.
        if (isLegendary(cardId)) await burnWorstPrints(tx, userId!, cardId, 1);
        const after = await tx.userCard.findUnique({
          where: { userId_cardId: { userId: userId!, cardId } },
          select: { count: true, skillLevel: true },
        });
        return { count: after?.count ?? 0, skillLevel: after?.skillLevel ?? level + 1 };
      });

      const power = ability.type === "domain"
        ? domainPower(ability.def, out.skillLevel)
        : skillPower(ability.def, out.skillLevel);

      res.json({
        success: true,
        data: {
          ...out,
          cardId,
          abilityType: ability.type,
          skillName: ability.def.name,
          power,
          text: ability.def.text(power),
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
    const free = await isLeadDevFree(userId!);

    try {
      const out = await prisma.$transaction(async (tx) => {
        // One conditional decrement makes the affordability check and the spend
        // a single operation — two fast clicks can't both pass.
        if (!free) {
          const paid = await tx.user.updateMany({
            where: { id: userId, shards: { gte: cost } },
            data: { shards: { decrement: cost } },
          });
          if (paid.count === 0) throw new Error("POOR");
        }
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

/**
 * POST /api/cards/merge  body { userId, cardId }
 *
 * Feed a DUPLICATE OF THE SAME CARD into itself, plus shards, and the copy you
 * keep gets permanently stronger. The spare is gone.
 *
 * SAME CARD, not merely the same rank. An earlier pass allowed any card of the
 * matching rarity as fodder, which quietly made every common interchangeable
 * with every other common — a card you chased was worth exactly as much fed
 * into something else as the filler you opened beside it. Requiring the same
 * name means strengthening a card is gated on pulling THAT card again, so the
 * chase and the upgrade are the same activity.
 *
 * It also removes a whole class of edge case: the target and the fodder are one
 * row, so there is no second card that can hit zero copies, vanish from a deck,
 * or strand a showcase pin mid-transaction.
 *
 * The gain is written straight into the copy's PULL ROLL rather than kept as a
 * separate multiplier. Two reasons. Every surface that already shows rolled
 * stats shows the merge for free, with no new plumbing to forget. And it makes
 * the feature mean what it says: the card itself changed, rather than acquiring
 * a modifier that follows it around.
 *
 * `merges` is capped at MERGE_MAX because the roll's promise — the tier you
 * pulled is the tier you got — has to survive this. Five merges is +40%, held
 * deliberately under the gap to the next rarity.
 */
export const mergeCards = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, cardId, fodderCardId } = (req.body || {}) as {
      userId?: string; cardId?: string; fodderCardId?: string;
    };
    if (!ownerGuard(req, res, userId)) return;
    if (!cardId) {
      return res.status(400).json({ success: false, message: "Pick a card to strengthen." });
    }

    const def = CARDS[cardId];
    if (!def) return res.status(404).json({ success: false, message: "No such card." });

    /**
     * `fodderCardId` is still accepted so an older client that sends it keeps
     * working, but it may now only ever name the SAME card. Refused loudly
     * rather than ignored: silently merging the wrong thing would eat a copy
     * the player did not offer.
     */
    if (fodderCardId && fodderCardId !== cardId) {
      const other = CARDS[fodderCardId];
      return res.status(400).json({
        success: false,
        message: `Merging needs two copies of the same card. ${other?.name ?? "That card"} can't be fed into ${def.name}.`,
      });
    }

    // Supports and grounds have no stat line to raise — rollStats returns null
    // for them precisely because their printed effect IS the card. Merging one
    // would take a copy and shards and change nothing at all.
    if (def.support || def.ground) {
      return res.status(400).json({ success: false, message: `${def.name} has no stat line to strengthen.` });
    }

    const printed = printedStats(def);
    // Read BEFORE the transaction, like every other paid action here: it hits
    // the global client rather than `tx`, so awaiting it mid-transaction would
    // hold the row lock open across an unrelated connection.
    const free = await isLeadDevFree(userId!);

    try {
      const out = await prisma.$transaction(async (tx) => {
        const target = await tx.userCard.findUnique({
          where: { userId_cardId: { userId: userId!, cardId } },
          select: { count: true, merges: true, rolledHp: true, rolledAtk: true, hibernating: true },
        });
        if (!target) throw new CardError(404, `You don't own ${def.name}.`);
        if (target.hibernating) throw new CardError(400, `${def.name} is asleep. Wake it first.`);

        const merges = target.merges || 0;
        if (merges >= MERGE_MAX) {
          throw new CardError(400, `${def.name} has been merged ${MERGE_MAX} times. That's as far as it goes.`);
        }

        /**
         * TWO COPIES MINIMUM. The fodder is a duplicate of this same card, so
         * the count must survive the meal — at one copy the card would eat
         * itself and leave nothing behind.
         *
         * Because target and fodder are the SAME ROW, the count can never
         * reach zero here: it goes N to N-1 with N >= 2. That is why there is
         * no last-copy deletion and no showcase rescue in this path — a pinned
         * card cannot be made to vanish by merging it.
         */
        if (target.count < 2) {
          throw new CardError(400, `You only have one ${def.name}. Merging needs a spare copy of the same card.`);
        }

        const cost = mergeCost(def.rarity, merges);
        if (!free) {
          const paid = await tx.user.updateMany({
            where: { id: userId, shards: { gte: cost } },
            data: { shards: { decrement: cost } },
          });
          if (paid.count === 0) throw new CardError(402, `Merging ${def.name} costs ${cost} shards.`);
        }

        // ── CONSUME THE SPARE ── guarded on the count we read, so two fast
        // clicks can't both spend the same duplicate.
        const eaten = await tx.userCard.updateMany({
          where: { userId, cardId, count: target.count },
          data: { count: { decrement: 1 } },
        });
        if (eaten.count === 0) throw new CardError(409, "Your copies just changed — try again.");
        // Legendaries carry per-copy print identities. A count that moves
        // without its prints moving leaves a serial owned by nobody and the
        // mint permanently out of step with the shelf. Burns the WORST copy,
        // so merging costs you your scruffiest print and never your best.
        if (isLegendary(cardId)) {
          await burnWorstPrints(tx, userId!, cardId, 1);
        }

        // ── RAISE THE ROLL ── off PRINTED stats, never off the current rolled
        // value. Compounding on the running total would make merge five worth
        // far more than merge one and blow straight through the +40% ceiling.
        const stepHp = Math.max(1, Math.round(printed.hp * MERGE_STEP));
        const stepAtk = Math.max(1, Math.round(printed.atk * MERGE_STEP));
        // A copy pulled before rolls existed has no roll to raise. Seed it from
        // printed so it starts level with everyone else rather than being
        // rebuilt from zero.
        const baseHp = typeof target.rolledHp === "number" && target.rolledHp > 0 ? target.rolledHp : printed.hp;
        const baseAtk = typeof target.rolledAtk === "number" && target.rolledAtk > 0 ? target.rolledAtk : printed.atk;

        const bumped = await tx.userCard.updateMany({
          where: { userId, cardId, merges },
          data: { rolledHp: baseHp + stepHp, rolledAtk: baseAtk + stepAtk, merges: { increment: 1 } },
        });
        if (bumped.count === 0) throw new CardError(409, "That merge already went through.");

        const u = await tx.user.findUnique({ where: { id: userId }, select: { shards: true } });
        return {
          cardId,
          // What the shelf looks like AFTER the meal, so the client doesn't have
          // to re-derive it and briefly show a count that no longer exists.
          count: target.count - 1,
          spent: free ? 0 : cost,
          shards: u?.shards ?? 0,
          merges: merges + 1,
          rolledHp: baseHp + stepHp,
          rolledAtk: baseAtk + stepAtk,
          gainedHp: stepHp,
          gainedAtk: stepAtk,
          nextCost: merges + 1 >= MERGE_MAX ? null : mergeCost(def.rarity, merges + 1),
        };
      });

      // No showcase prune here on purpose. Profiles render through
      // liveShowcase(), which drops pins the player no longer holds at READ
      // time — so a fed-away last copy stops showing on its own. Writing a
      // prune here as well would be a second source of truth for the same
      // question, which is how the stranded-legendary bug happened the first
      // time.
      res.json({ success: true, data: out });
    } catch (e) {
      if (e instanceof CardError) return res.status(e.code).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    next(error);
  }
};
