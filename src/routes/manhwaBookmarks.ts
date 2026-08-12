import express from "express";
import { PrismaClient } from "@prisma/client";
import { resolveActor } from "../lib/staff";
import { effectiveTrackedAt, withEffectiveTrackedAt } from "../lib/bookmarkTracking";

const router = express.Router();
const prisma = new PrismaClient();

/**
 * RESPONSE SHAPE — every bookmark row this router returns carries `trackedAt`.
 *
 * NON-NULL  → the member added this title to their library. It is public: this
 *             is what the profile shelf renders.
 * NULL      → a PROGRESS-ONLY row, created by POST /progress because the member
 *             opened a chapter. Private. It is still returned (lastChapterId
 *             lives on it and "continue reading" needs it), but it is not
 *             library membership and must not be drawn as one.
 *
 * The value is always the EFFECTIVE one (src/lib/bookmarkTracking.ts), never
 * the raw column — pre-existing rows carry NULL in the database and are
 * genuine adds. Clients may trust `trackedAt != null` from this API; nothing
 * may trust it straight off a Prisma row.
 */

/**
 * RECORD READING PROGRESS — the cross-device half of "continue reading".
 *
 * Upserts on the existing userId+mangaId pair, so opening a chapter for a
 * series that was never explicitly added CREATES the row. That is deliberate:
 * requiring an add-to-library step first is exactly what made progress feel
 * device-local, and a 404 here would strand the most common case.
 *
 * THE ROW IT CREATES IS NOT A LIBRARY ADD. It leaves `trackedAt` null, which
 * is what keeps it off the public profile shelf. Reading one chapter used to
 * publish the title to every visitor of your profile — the row was created
 * with status "READING" and the profile payload includes these rows wholesale.
 *
 * IDENTITY COMES FROM THE VERIFIED TOKEN, never from the body. An earlier
 * generation of these routes took `userId` from req.body — anyone who knew an
 * id could write to another account's shelf. Only the owner writes their own
 * progress.
 *
 * STALE WRITES ARE REJECTED, not applied. A phone that read offline flushes
 * when it reconnects, and that flush can arrive AFTER a newer read from a
 * laptop. `readAt` (clamped — a client clock running fast must not win forever)
 * lets the older write identify itself, and we keep the newer row instead of
 * letting arrival order decide. Same last-write-wins rule the client uses.
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

    const { mangaId, chapterId, title, coverImage } = req.body || {};
    if (typeof mangaId !== "string" || !mangaId || typeof chapterId !== "string" || !chapterId) {
      return res.status(400).json({ success: false, error: "mangaId and chapterId are required" });
    }

    const readAt = resolveReadAt(req.body?.readAt);

    const existing = await prisma.manhwaBookmark.findUnique({
      where: { userId_mangaId: { userId: actor.id, mangaId } },
    });

    // Already hold a newer read for this title — the caller is behind. Hand
    // back what we have so it can reconcile down to the truth.
    if (existing?.lastReadAt && existing.lastReadAt.getTime() > readAt.getTime()) {
      return res.json({ success: true, data: withEffectiveTrackedAt(existing), applied: false });
    }

    const bookmark = await prisma.manhwaBookmark.upsert({
      where: { userId_mangaId: { userId: actor.id, mangaId } },
      update: {
        lastChapterId: chapterId,
        lastReadAt: readAt,
        // Only refresh the denormalized display fields when the caller actually
        // supplied them — a progress ping must never blank an existing cover,
        // and must never touch `status` (that is the tracker's business).
        //
        // `trackedAt` is ABSENT here, and must stay absent. If this row is
        // already in the member's library, reading another chapter of it must
        // not take it back out; if it is progress-only, reading must not put it
        // in. Writing `trackedAt: null` here — even "for consistency" with the
        // create branch below — would un-library every title the member is
        // actively reading.
        ...(typeof title === "string" && title ? { title } : {}),
        ...(typeof coverImage === "string" && coverImage ? { coverImage } : {}),
      },
      create: {
        userId: actor.id,
        mangaId,
        title: typeof title === "string" && title ? title : mangaId,
        coverImage: typeof coverImage === "string" && coverImage ? coverImage : null,
        // status is the tracker's display value; it is NOT membership. The row
        // is born progress-only — `trackedAt` stays null — so it carries the
        // reader's place without publishing the title to their public shelf.
        // Only a real add (POST /, or a PATCH setting a status) stamps it.
        status: "READING",
        lastChapterId: chapterId,
        lastReadAt: readAt,
      },
    });

    res.json({ success: true, data: withEffectiveTrackedAt(bookmark), applied: true });
  } catch (error) {
    console.error("Error recording manhwa progress:", error);
    res.status(500).json({ success: false, error: "Failed to record progress" });
  }
});

// Get all manhwa bookmarks for a specific user.
//
// Returns BOTH library titles and progress-only rows on purpose — the client
// needs lastChapterId for a title it is merely reading. `trackedAt` is what
// tells the two apart (see the response-shape note at the top of this file);
// it is normalized here so a client never sees the raw, ambiguous NULL.
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const bookmarks = await prisma.manhwaBookmark.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' }
    });
    res.json({ success: true, data: bookmarks.map(withEffectiveTrackedAt) });
  } catch (error) {
    console.error("Error fetching manhwa bookmarks:", error);
    res.status(500).json({ success: false, error: "Failed to fetch manhwa bookmarks" });
  }
});

// Add a new manhwa bookmark — THE REAL ADD. This is the "Add to library" path,
// so this is where `trackedAt` is stamped.
router.post("/", async (req, res) => {
  try {
    const { userId, mangaId, title, coverImage, status } = req.body;

    if (!userId || !mangaId || !title) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    // The row may already exist as a progress-only pointer (the member read a
    // chapter before adding it) — that is the whole point of the split, and the
    // add is what promotes it. Read it first so the stamp is COALESCED rather
    // than overwritten: a title added months ago keeps its original tracked
    // moment through every later status change, and a legacy row materializes
    // its effective value into the column instead of leaning on the read-time
    // rule forever. Only a row with no claim to membership gets `now`.
    const existing = await prisma.manhwaBookmark.findUnique({
      where: { userId_mangaId: { userId, mangaId } },
    });
    const trackedAt = (existing && effectiveTrackedAt(existing)) || new Date();

    const bookmark = await prisma.manhwaBookmark.upsert({
      where: {
        userId_mangaId: {
          userId,
          mangaId
        }
      },
      update: {
        title,
        coverImage,
        status: status || "READING",
        trackedAt,
        updatedAt: new Date()
      },
      create: {
        userId,
        mangaId,
        title,
        coverImage,
        status: status || "READING",
        trackedAt
      }
    });

    res.json({ success: true, data: withEffectiveTrackedAt(bookmark) });
  } catch (error) {
    console.error("Error creating manhwa bookmark:", error);
    res.status(500).json({ success: false, error: "Failed to create manhwa bookmark" });
  }
});

// Update a manhwa bookmark status. Setting a status IS a library add — it is
// what the tracker dropdown sends for a title the member already has a row for,
// which after the progress split is the common case (they read a chapter first,
// then chose "Reading"). So this stamps `trackedAt` too, coalesced exactly like
// POST / above; without it the dropdown would silently fail to add anything the
// reader had already opened.
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const hasStatus = typeof status === "string" && status.length > 0;

    const existing = await prisma.manhwaBookmark.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: "Bookmark not found" });
    }

    const bookmark = await prisma.manhwaBookmark.update({
      where: { id },
      // No status in the body = nothing is being tracked or changed, so this
      // stays the no-op it has always been rather than stamping membership.
      data: hasStatus
        ? { status, trackedAt: effectiveTrackedAt(existing) || new Date() }
        : {}
    });

    res.json({ success: true, data: withEffectiveTrackedAt(bookmark) });
  } catch (error) {
    console.error("Error updating manhwa bookmark:", error);
    res.status(500).json({ success: false, error: "Failed to update manhwa bookmark" });
  }
});

// Delete a manhwa bookmark
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.manhwaBookmark.delete({
      where: { id }
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting manhwa bookmark:", error);
    res.status(500).json({ success: false, error: "Failed to delete manhwa bookmark" });
  }
});

export default router;
