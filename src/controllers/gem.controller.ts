import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { resolveActor } from "../lib/staff";

/**
 * HIDDEN GEMS — a weekly community pick.
 *
 * Everyone gets one vote per week per mode. The tally for a week IS the
 * ranking, so the uniqueness constraint on (userId, week, mediaType) is the
 * whole anti-stuffing story — which is exactly why identity here comes from
 * the verified token and never from req.body.userId. A body-trusted userId
 * would let anyone spend everybody else's vote.
 *
 * Changing your mind replaces your pick rather than adding a second, so the
 * counts always equal the number of distinct people who voted.
 */

/**
 * ISO-8601 week key, e.g. "2026-W31". ISO weeks start Monday and week 1 is the
 * one containing the first Thursday, which is why the date is shifted to the
 * Thursday of its own week before counting — a naive "day of year / 7" is off
 * by one for most of January.
 */
export function weekKey(d: Date = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Sunday is 0 in JS but day 7 in ISO.
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The week key `n` weeks before the one containing `d`. */
function weekKeyOffset(n: number, d: Date = new Date()): string {
  const shifted = new Date(d.getTime() - n * 7 * 86400000);
  return weekKey(shifted);
}

/**
 * Which modes can run a weekly gem vote. Anime was excluded only because the
 * feature shipped alongside the manhwa and novel home rebuilds — nothing about
 * the vote is reading-specific. The GemVote row is keyed
 * `@@unique([userId, week, mediaType])`, so a third mediaType needs no schema
 * change and cannot collide with the existing two.
 */
const MODES = new Set(["anime", "manhwa", "novel"]);

/**
 * GET /api/gems?mediaType=manhwa
 * Returns this week's standings and last week's winner, plus the caller's own
 * pick so the UI can show what they chose without a second request.
 */
export const getGems = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mediaType = String(req.query.mediaType || "manhwa");
    if (!MODES.has(mediaType)) {
      return res.status(400).json({ success: false, message: "Unknown mode." });
    }

    const thisWeek = weekKey();
    const lastWeek = weekKeyOffset(1);

    const [current, previous] = await Promise.all([
      prisma.gemVote.findMany({ where: { week: thisWeek, mediaType } }),
      prisma.gemVote.findMany({ where: { week: lastWeek, mediaType } }),
    ]);

    // Tally in JS rather than groupBy: the rows also carry the denormalised
    // title and cover we need, so grouping in SQL would still need a second
    // pass to get them back.
    const tally = (rows: typeof current) => {
      const byId = new Map<string, { mediaId: string; title: string; cover: string | null; votes: number }>();
      for (const r of rows) {
        const seen = byId.get(r.mediaId);
        if (seen) seen.votes++;
        else byId.set(r.mediaId, { mediaId: r.mediaId, title: r.title, cover: r.cover, votes: 1 });
      }
      return Array.from(byId.values()).sort((a, b) => b.votes - a.votes || a.title.localeCompare(b.title));
    };

    const actor = await resolveActor(req);
    const myPick = actor
      ? current.find((r) => r.userId === actor.id) || null
      : null;

    res.json({
      success: true,
      data: {
        week: thisWeek,
        standings: tally(current).slice(0, 10),
        lastWinner: tally(previous)[0] || null,
        myPick: myPick ? { mediaId: myPick.mediaId, title: myPick.title } : null,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/gems  { mediaType, mediaId, title, cover }
 * Casts or moves this week's pick.
 */
export const castGemVote = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // The uniqueness rule above is only worth anything if this cannot be
    // spoofed — hence the token, with no body fallback.
    const actor = await resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: "Sign in to vote." });
    }

    const mediaType = String(req.body?.mediaType || "");
    const mediaId = String(req.body?.mediaId || "").trim();
    const title = String(req.body?.title || "").trim();
    const coverRaw = req.body?.cover;
    const cover = typeof coverRaw === "string" && coverRaw.trim() ? coverRaw.trim().slice(0, 600) : null;

    if (!MODES.has(mediaType)) {
      return res.status(400).json({ success: false, message: "Unknown mode." });
    }
    if (!mediaId || mediaId.length > 300 || !title) {
      return res.status(400).json({ success: false, message: "Pick something to vote for." });
    }

    const week = weekKey();

    const vote = await prisma.gemVote.upsert({
      where: { userId_week_mediaType: { userId: actor.id, week, mediaType } },
      update: { mediaId, title: title.slice(0, 300), cover },
      create: { userId: actor.id, week, mediaType, mediaId, title: title.slice(0, 300), cover },
    });

    res.json({ success: true, data: { mediaId: vote.mediaId, title: vote.title, week } });
  } catch (error) {
    next(error);
  }
};
