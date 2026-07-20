import express from "express";
import { prisma } from "../lib/prisma";

// Tracks SCRAPED novels on a user's profile. Mirrors manhwaBookmarks.ts — the
// novelId is a source slug ("fmtl:<slug>" or a bare ReadNovelFull slug), not a
// Novel row, so title/coverImage are denormalized onto the bookmark.
const router = express.Router();

// Get all novel bookmarks for a specific user
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const bookmarks = await prisma.novelBookmark.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ success: true, data: bookmarks });
  } catch (error) {
    console.error("Error fetching novel bookmarks:", error);
    res.status(500).json({ success: false, error: "Failed to fetch novel bookmarks" });
  }
});

// Add / update a novel bookmark
router.post("/", async (req, res) => {
  try {
    const { userId, novelId, title, coverImage, status } = req.body;

    if (!userId || !novelId) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const bookmark = await prisma.novelBookmark.upsert({
      where: { userId_novelId: { userId, novelId } },
      update: {
        title,
        coverImage,
        status: status || "READING",
        updatedAt: new Date(),
      },
      create: {
        userId,
        novelId,
        title,
        coverImage,
        status: status || "READING",
      },
    });

    res.json({ success: true, data: bookmark });
  } catch (error) {
    console.error("Error creating novel bookmark:", error);
    res.status(500).json({ success: false, error: "Failed to create novel bookmark" });
  }
});

// Update a novel bookmark status
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const bookmark = await prisma.novelBookmark.update({
      where: { id },
      data: { status },
    });

    res.json({ success: true, data: bookmark });
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
