import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { finishBonus } from "../utils/economy";
import { getActorId } from "../lib/jwt";

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
        // The update already returns the row, so the username costs no extra
        // query — see the link below for why it is needed.
        const paid = await prisma.user.update({
          where: { id: userId },
          data: { arisePoints: { increment: 2 } },
          select: { username: true },
        });
        await prisma.pointLog.create({ data: { userId, amount: 2, reason: addKey } });
        await prisma.notification.create({
          data: {
            userId,
            actorId: userId,
            type: "ARISE_POINTS_WATCHLIST",
            message: `You earned 2 Arise Points for adding ${createData.title || 'an anime'} to your list!`,
            /**
             * `/profile` does not exist and never has. The app's own profile
             * route is `/user/[username]`, so every one of these notifications
             * has been a guaranteed 404 for as long as they have been sent —
             * the notification is stored, so the dead link is also sitting in
             * the database on every past one.
             *
             * Falls back to the anime that was added when the username is
             * somehow missing: a real page about the thing the notification is
             * about beats another dead end.
             */
            link: paid.username
              ? `/user/${encodeURIComponent(paid.username)}`
              : `/anime/${createData.anilistId}`,
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

/**
 * Save the resume point for a tracked anime.
 *
 * POST /api/watchlist/progress
 * body: { userId, anilistId, episode, seconds?, duration? }
 *
 * NOTE ON THE KEY: `anilistId` actually stores the MAL id — the frontend sends
 * `anime.mal_id` into that column (see useAnimeStatus.ts, which documents keeping
 * the old field name to avoid a breaking rename). So this keys off exactly the
 * same value the Continue Watching card uses, with no id-space translation.
 *
 * Uses updateMany rather than upsert on purpose: `title` and `status` are
 * required columns, so a progress ping for an untracked anime must NOT invent a
 * half-populated watchlist row. Zero rows updated is the correct outcome there.
 */
export const saveWatchProgress = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, anilistId, episode, seconds, duration } = (req.body || {}) as {
      userId?: string;
      anilistId?: number | string;
      episode?: number | string;
      seconds?: number | string;
      duration?: number | string;
    };

    if (!userId || anilistId == null || episode == null) {
      return res.status(400).json({ success: false, message: "Missing userId, anilistId or episode." });
    }

    // You can only move your own resume point (verified token wins; tokenless
    // pre-JWT sessions grandfathered, matching earnPoints/addXpForWatching).
    const actor = getActorId(req);
    if (actor && actor !== userId) {
      return res.status(403).json({ success: false, message: "You can only update your own progress." });
    }

    const id = Number(anilistId);
    const ep = Number(episode);
    if (!Number.isFinite(id) || !Number.isFinite(ep) || ep < 0) {
      return res.status(400).json({ success: false, message: "Invalid anilistId or episode." });
    }

    const secs = Number(seconds);
    const dur = Number(duration);

    const result = await prisma.watchlistItem.updateMany({
      where: { userId, anilistId: id },
      data: {
        progressEpisode: Math.floor(ep),
        // Only overwrite the position when we actually have a sane one, so a
        // ping fired before the player reports timing can't wipe a good value.
        ...(Number.isFinite(secs) && secs > 0 ? { progressSeconds: Math.floor(secs) } : {}),
        ...(Number.isFinite(dur) && dur > 0 ? { progressDuration: Math.floor(dur) } : {}),
        progressAt: new Date(),
      },
    });

    res.json({ success: true, updated: result.count });
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
