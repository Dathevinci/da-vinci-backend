import express from "express";
import { prisma } from "../lib/prisma";
import { resolveActor } from "../lib/staff";
import { effectiveTrackedAt, withEffectiveTrackedAt } from "../lib/bookmarkTracking";

// Tracks SCRAPED novels on a user's profile. Mirrors manhwaBookmarks.ts — the
// novelId is a source slug ("fmtl:<slug>" or a bare ReadNovelFull slug), not a
// Novel row, so title/coverImage are denormalized onto the bookmark.
const router = express.Router();

/**
 * RESPONSE SHAPE — every bookmark row this router returns carries `trackedAt`.
 * NON-NULL = the member added this novel to their library (public, rendered on
 * the profile shelf). NULL = a PROGRESS-ONLY row created by POST /progress when
 * they opened a chapter: private, still returned because lastChapterId lives on
 * it, but not membership. Always the EFFECTIVE value, never the raw column —
 * see src/lib/bookmarkTracking.ts and the twin note in manhwaBookmarks.ts.
 */

/**
 * RECORD READING PROGRESS — mirrors POST /api/manhwa-bookmarks/progress; see
 * that file for the full reasoning. In short: upsert on userId+novelId so
 * opening a chapter creates the row rather than 404ing, identity from the
 * VERIFIED token only, and a write that declares an older `readAt` than the
 * stored one is rejected instead of clobbering it — and the row it creates is
 * PROGRESS ONLY (`trackedAt` left null), so reading a chapter never publishes
 * the novel to the reader's public shelf.
 */
function resolveReadAt(raw: unknown): Date {
  const now = Date.now();
  const at = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  return new Date(at > 0 && at < now ? at : now);
}

router.post("/progress", async (req, res) => {
  try {
    const actor = await resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, error: "Sign in again to sync progress." });
    }

    const { novelId, chapterId, title, coverImage } = req.body || {};
    if (typeof novelId !== "string" || !novelId || typeof chapterId !== "string" || !chapterId) {
      return res.status(400).json({ success: false, error: "novelId and chapterId are required" });
    }

    const readAt = resolveReadAt(req.body?.readAt);

    const existing = await prisma.novelBookmark.findUnique({
      where: { userId_novelId: { userId: actor.id, novelId } },
    });

    if (existing?.lastReadAt && existing.lastReadAt.getTime() > readAt.getTime()) {
      return res.json({ success: true, data: withEffectiveTrackedAt(existing), applied: false });
    }

    const bookmark = await prisma.novelBookmark.upsert({
      where: { userId_novelId: { userId: actor.id, novelId } },
      update: {
        lastChapterId: chapterId,
        lastReadAt: readAt,
        // Never blank an existing title/cover from a progress ping, and never
        // touch `status` — that belongs to the tracker.
        //
        // `trackedAt` is ABSENT here and must stay absent: reading another
        // chapter must neither remove a novel from the library nor add one.
        ...(typeof title === "string" && title ? { title } : {}),
        ...(typeof coverImage === "string" && coverImage ? { coverImage } : {}),
      },
      create: {
        userId: actor.id,
        novelId,
        title: typeof title === "string" && title ? title : null,
        coverImage: typeof coverImage === "string" && coverImage ? coverImage : null,
        // Born progress-only: `trackedAt` stays null. `status` is a display
        // value, not membership — only a real add stamps membership.
        status: "READING",
        lastChapterId: chapterId,
        lastReadAt: readAt,
      },
    });

    res.json({ success: true, data: withEffectiveTrackedAt(bookmark), applied: true });
  } catch (error) {
    console.error("Error recording novel progress:", error);
    res.status(500).json({ success: false, error: "Failed to record progress" });
  }
});

// Get all novel bookmarks for a specific user.
//
// Progress-only rows are returned too — the client needs lastChapterId for a
// novel it is merely reading. `trackedAt` (normalized, never the raw NULL) is
// what separates those from library membership.
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const bookmarks = await prisma.novelBookmark.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ success: true, data: bookmarks.map(withEffectiveTrackedAt) });
  } catch (error) {
    console.error("Error fetching novel bookmarks:", error);
    res.status(500).json({ success: false, error: "Failed to fetch novel bookmarks" });
  }
});

// Add / update a novel bookmark — THE REAL ADD, so this is where `trackedAt`
// is stamped. Coalesced, not overwritten: an existing claim to membership (an
// earlier add, or a legacy row) keeps its original moment, and only a row with
// no claim — a progress-only pointer, or no row at all — gets `now`.
router.post("/", async (req, res) => {
  try {
    const { userId, novelId, title, coverImage, status } = req.body;

    if (!userId || !novelId) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const existing = await prisma.novelBookmark.findUnique({
      where: { userId_novelId: { userId, novelId } },
    });
    const trackedAt = (existing && effectiveTrackedAt(existing)) || new Date();

    const bookmark = await prisma.novelBookmark.upsert({
      where: { userId_novelId: { userId, novelId } },
      update: {
        title,
        coverImage,
        status: status || "READING",
        trackedAt,
        updatedAt: new Date(),
      },
      create: {
        userId,
        novelId,
        title,
        coverImage,
        status: status || "READING",
        trackedAt,
      },
    });

    res.json({ success: true, data: withEffectiveTrackedAt(bookmark) });
  } catch (error) {
    console.error("Error creating novel bookmark:", error);
    res.status(500).json({ success: false, error: "Failed to create novel bookmark" });
  }
});

// Update a novel bookmark status. Setting a status IS a library add — after
// the progress split the tracker usually PATCHes a row the reader's chapter
// already created, so this must stamp `trackedAt` or the dropdown would add
// nothing for any novel they had opened. Coalesced, like POST / above.
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const hasStatus = typeof status === "string" && status.length > 0;

    const existing = await prisma.novelBookmark.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: "Bookmark not found" });
    }

    const bookmark = await prisma.novelBookmark.update({
      where: { id },
      // No status in the body = nothing to track, so this stays the no-op it
      // has always been rather than stamping membership.
      data: hasStatus
        ? { status, trackedAt: effectiveTrackedAt(existing) || new Date() }
        : {},
    });

    res.json({ success: true, data: withEffectiveTrackedAt(bookmark) });
  } catch (error) {
    console.error("Error updating novel bookmark:", error);
    res.status(500).json({ success: false, error: "Failed to update novel bookmark" });
  }
});

// Delete a novel bookmark
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.novelBookmark.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting novel bookmark:", error);
    res.status(500).json({ success: false, error: "Failed to delete novel bookmark" });
  }
});

export default router;
