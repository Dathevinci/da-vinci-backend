import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { finishBonus } from "../utils/economy";

// Award the completion payout for finishing an anime, priced off its RUNTIME —
// once per anime per user (deduped via the point log), whether the item was
// created as FINISHED or later updated to it.
async function grantFinishBonus(
  userId: string,
  anilistId: number,
  title: string,
  episodes: any,
  duration: any
) {
  const finishKey = `finish:${anilistId}`;
  const already = await prisma.pointLog.findFirst({ where: { userId, reason: finishKey } });
  if (already) return;

  const { ap, xp, hours } = finishBonus(episodes, duration);
  // Runtime unknown (still-airing, or AniList has no episode count)? Pay nothing
  // and log nothing, so the once-per-anime dedup can't lock in a floored payout
  // before backfill-runtimes.ts learns the real length.
  if (hours <= 0) return;

  const hoursLabel = hours >= 1 ? `${Math.round(hours)}h` : `${Math.round(hours * 60)}m`;

  await prisma.user.update({
    where: { id: userId },
    data: { arisePoints: { increment: ap }, xp: { increment: xp } },
  });
  await prisma.pointLog.create({ data: { userId, amount: ap, reason: finishKey } });
  await prisma.notification.create({
    data: {
      userId,
      actorId: userId,
      type: "ARISE_POINTS_FINISHED",
      message: `You finished ${title} — ${hoursLabel} watched, +${xp.toLocaleString()} XP and +${ap.toLocaleString()} Arise Points!`,
      link: `/profile`,
    },
  });
}

// The client may send episodes/duration as a number, a numeric string, or junk
// ("Unknown", null). Coerce to a positive Int or null so Prisma never chokes,
// and CLAMP — these are client-controlled multipliers on the payout and on the
// public Hours Watched stat, and nothing else validates them.
function toInt(v: any, max: number): number | null {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, max);
}
const MAX_EPISODES = 5000;   // AniList's longest is ~3000
const MAX_EP_MINUTES = 240;  // no episode or film runs over 4h

export const addToWatchlist = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body ?? {};
    const episodes = toInt(body.episodes, MAX_EPISODES);
    const duration = toInt(body.duration, MAX_EP_MINUTES);
    const { episodes: _e, duration: _d, ...rest } = body;
    const createData = { ...rest, episodes, duration };

    const item = await prisma.watchlistItem.create({
      data: createData,
    });

    const userId = createData.userId;
    if (userId) {
      // +2 for adding — once per anime per user, and logged like every other
      // payout. Without the dedup, delete + re-add mints 2 AP on a loop forever.
      const addKey = `add:${createData.anilistId}`;
      const addedBefore = await prisma.pointLog.findFirst({ where: { userId, reason: addKey } });
      if (!addedBefore) {
        await prisma.user.update({
          where: { id: userId },
          data: { arisePoints: { increment: 2 } }
        });
        await prisma.pointLog.create({ data: { userId, amount: 2, reason: addKey } });
        await prisma.notification.create({
          data: {
            userId,
            actorId: userId,
            type: "ARISE_POINTS_WATCHLIST",
            message: `You earned 2 Arise Points for adding ${createData.title || 'an anime'} to your list!`,
            link: `/profile`
          }
        });
      }

      // Added straight to Finished (e.g. from the detail page)? Grant the payout too.
      if (createData.status === "FINISHED") {
        await grantFinishBonus(userId, createData.anilistId, createData.title || "an anime", episodes, duration);
      }
    }

    res.status(201).json({ success: true, data: item });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ success: false, message: "Anime already in watchlist" });
    }
    next(error);
  }
};

export const getWatchlist = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await prisma.watchlistItem.findMany({
      where: { userId: req.params.userId as string },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ success: true, data: list });
  } catch (error) {
    next(error);
  }
};

export const updateWatchlistItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await prisma.watchlistItem.findUnique({
      where: { id: req.params.id as string }
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    const body = req.body ?? {};
    const episodes = toInt(body.episodes, MAX_EPISODES);
    const duration = toInt(body.duration, MAX_EP_MINUTES);
    const { episodes: _e, duration: _d, ...rest } = body;
    const updateData: any = { ...rest };
    // Only write runtime metadata when the client actually sent it, so a plain
    // status PATCH can never wipe what we already know (or backfilled).
    if (episodes !== null) updateData.episodes = episodes;
    if (duration !== null) updateData.duration = duration;

    const item = await prisma.watchlistItem.update({
      where: { id: req.params.id as string },
      data: updateData,
    });

    // Reward finishing — priced off runtime, once per anime ever (dedup lives in
    // the helper, so toggling Finished off/on can't farm the payout). Fall back
    // to the stored/backfilled runtime when the client didn't send it.
    if (body.status === "FINISHED" && existing.status !== "FINISHED") {
      await grantFinishBonus(
        existing.userId,
        existing.anilistId,
        item.title,
        episodes ?? item.episodes,
        duration ?? item.duration
      );
    }

    res.json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
};

export const deleteWatchlistItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.watchlistItem.delete({
      where: { id: req.params.id as string },
    });
    res.json({ success: true, message: "Item removed" });
  } catch (error) {
    next(error);
  }
};
