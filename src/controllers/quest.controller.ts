import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { getActorId } from "../lib/jwt";
import { creditGuildXp } from "../lib/guildXp";
import {
  ALL_DONE_BONUS,
  QUEST_PREFIX,
  ROTATION_DAYS,
  activeQuests,
  cycleEndsAt,
  cycleIndex,
  getQuest,
  dayKey,
  startOfUtcDay,
  nextUtcMidnight,
  claimReason,
  type DailyQuest,
} from "../data/dailyQuests";

/**
 * Daily quests. Progress is DERIVED from today's PointLog rows; claims are
 * recorded as PointLog rows too. See src/data/dailyQuests.ts for why there is no
 * quest table.
 *
 * Ownership follows the same rule as earnPoints: a verified token must match the
 * target account, and tokenless pre-JWT sessions are grandfathered so existing
 * users aren't locked out mid-session.
 *
 * The claim endpoint RE-COUNTS progress server-side. The client is never trusted
 * to say a quest is finished — otherwise the whole thing is a free AP button.
 */

function ownsAccount(req: Request, userId: string): boolean {
  const actor = getActorId(req);
  return !actor || actor === userId;
}

/** Does a ledger reason count toward this quest? */
function matches(q: DailyQuest, reason: string): boolean {
  switch (q.match.kind) {
    case "prefix":
      return reason.startsWith(q.match.value);
    case "prefixAny":
      return q.match.values.some((p) => reason.startsWith(p));
    case "exact":
      return reason === q.match.value;
    case "checkin":
      return false; // nothing to measure — claiming IS the action
  }
}

/**
 * Count today's qualifying rows for each quest on the CURRENT board, in one
 * query. `board` is passed in so the caller and this function can't disagree
 * about which lineup is live (they'd diverge if a rotation boundary fell between
 * two separate activeQuests() calls in the same request).
 */
async function loadToday(userId: string, board: DailyQuest[]) {
  const rows = await prisma.pointLog.findMany({
    where: { userId, createdAt: { gte: startOfUtcDay() } },
    select: { reason: true },
  });

  const today = dayKey();
  const claimed = new Set<string>();
  const counts: Record<string, number> = {};

  for (const r of rows) {
    // Claim rows are bookkeeping, never progress. Without this guard a `quest:`
    // row could satisfy a prefix quest and quests would feed themselves.
    if (r.reason.startsWith(QUEST_PREFIX)) {
      const suffix = `:${today}`;
      if (r.reason.endsWith(suffix)) {
        claimed.add(r.reason.slice(QUEST_PREFIX.length, r.reason.length - suffix.length));
      }
      continue;
    }
    for (const q of board) {
      if (matches(q, r.reason)) counts[q.id] = (counts[q.id] || 0) + 1;
    }
  }

  return { counts, claimed };
}

/** Consecutive days ending today (or yesterday) with at least one claim. */
async function computeStreak(userId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const rows = await prisma.pointLog.findMany({
    where: { userId, createdAt: { gte: since }, reason: { startsWith: QUEST_PREFIX } },
    select: { reason: true },
  });

  const days = new Set<string>();
  for (const r of rows) {
    const day = r.reason.slice(r.reason.lastIndexOf(":") + 1);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days.add(day);
  }
  if (days.size === 0) return 0;

  // Start from today if claimed, else yesterday — so a streak isn't reported
  // broken just because today's quests aren't done yet.
  const oneDay = 24 * 60 * 60 * 1000;
  let cursor = new Date(startOfUtcDay());
  if (!days.has(dayKey(cursor))) {
    cursor = new Date(cursor.getTime() - oneDay);
    if (!days.has(dayKey(cursor))) return 0;
  }

  let streak = 0;
  while (days.has(dayKey(cursor))) {
    streak++;
    cursor = new Date(cursor.getTime() - oneDay);
  }
  return streak;
}

/** GET /api/users/:id/quests */
export const getDailyQuests = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.id as string;
    if (!ownsAccount(req, userId)) {
      return res.status(403).json({ success: false, message: "You can only view your own quests." });
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    // Resolve the board ONCE and thread it through, so a rotation boundary
    // crossed mid-request can't make the counting disagree with the response.
    const board = activeQuests();
    const { counts, claimed } = await loadToday(userId, board);
    const streak = await computeStreak(userId);

    const quests = board.map((q) => {
      // The check-in has nothing to measure — it's complete by definition and the
      // claim itself is the action.
      const progress = q.match.kind === "checkin" ? (claimed.has(q.id) ? 1 : 0) : Math.min(counts[q.id] || 0, q.target);
      const done = q.match.kind === "checkin" ? true : (counts[q.id] || 0) >= q.target;
      return {
        id: q.id,
        label: q.label,
        hint: q.hint,
        target: q.target,
        ap: q.ap,
        xp: q.xp,
        progress,
        complete: done,
        claimed: claimed.has(q.id),
        claimable: done && !claimed.has(q.id),
      };
    });

    const allClaimed = quests.every((q) => q.claimed);
    const bonusClaimed = claimed.has(ALL_DONE_BONUS.id);

    res.json({
      success: true,
      data: {
        day: dayKey(),
        resetsAt: nextUtcMidnight().toISOString(),
        // The lineup clock, separate from the daily progress clock.
        cycle: cycleIndex(),
        rotationDays: ROTATION_DAYS,
        rotatesAt: cycleEndsAt().toISOString(),
        streak,
        quests,
        bonus: {
          id: ALL_DONE_BONUS.id,
          ap: ALL_DONE_BONUS.ap,
          xp: ALL_DONE_BONUS.xp,
          claimed: bonusClaimed,
          claimable: allClaimed && !bonusClaimed,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/** POST /api/users/:id/quests/:questId/claim */
export const claimDailyQuest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.id as string;
    const questId = req.params.questId as string;

    if (!ownsAccount(req, userId)) {
      return res.status(403).json({ success: false, message: "You can only claim your own quests." });
    }

    const board = activeQuests();
    const isBonus = questId === ALL_DONE_BONUS.id;
    const quest = isBonus ? null : getQuest(questId);
    if (!isBonus && !quest) {
      return res.status(400).json({ success: false, message: "Unknown quest." });
    }

    /**
     * The quest must be on the CURRENT board. getQuest() searches the whole pool,
     * so without this a client could claim any quest from any rotation — including
     * an easy one that isn't live — by posting its id directly.
     */
    if (!isBonus && !board.some((q) => q.id === questId)) {
      return res.status(409).json({ success: false, message: "That quest isn't in today's lineup." });
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    const { counts, claimed } = await loadToday(userId, board);

    if (claimed.has(questId)) {
      return res.status(409).json({ success: false, message: "Already claimed today." });
    }

    // Re-verify completion HERE. Never trust the client's idea of progress.
    if (isBonus) {
      const allDone = board.every((q) => claimed.has(q.id));
      if (!allDone) {
        return res.status(400).json({ success: false, message: "Claim every quest first." });
      }
    } else if (quest && quest.match.kind !== "checkin") {
      if ((counts[quest.id] || 0) < quest.target) {
        return res.status(400).json({ success: false, message: "That quest isn't finished yet." });
      }
    }

    const ap = isBonus ? ALL_DONE_BONUS.ap : quest!.ap;
    const xp = isBonus ? ALL_DONE_BONUS.xp : quest!.xp;
    const reason = claimReason(questId);

    /**
     * The PointLog row is created FIRST inside the transaction. `reason` has no
     * unique constraint, so two simultaneous claims could both pass the check
     * above; keeping the write and the balance change atomic means a duplicate is
     * at worst a double row rather than points granted with no ledger trace. The
     * pre-check plus the day-scoped reason makes an actual double-claim require
     * two requests inside the same few milliseconds.
     */
    const [, updated] = await prisma.$transaction([
      prisma.pointLog.create({ data: { userId, amount: ap, reason } }),
      prisma.user.update({
        where: { id: userId },
        data: { arisePoints: { increment: ap }, xp: { increment: xp } },
        select: { arisePoints: true, xp: true },
      }),
    ]);

    /**
     * The claimer's guild takes its share of the quest XP.
     *
     * AFTER the transaction, not inside it: this is the ARRAY form of
     * $transaction, which takes prepared promises and hands out no client to
     * write against. Placing the credit here also means the double-claim
     * guards above (the `claimed.has(questId)` check and the day-scoped
     * `reason`) sit between a repeat request and the guild — a rejected claim
     * has already returned, so a deduped claim can never feed the guild twice.
     */
    await creditGuildXp(userId, xp);

    res.json({
      success: true,
      data: { questId, ap, xp, arisePoints: (updated as any).arisePoints, xpTotal: (updated as any).xp },
    });
  } catch (error) {
    next(error);
  }
};
