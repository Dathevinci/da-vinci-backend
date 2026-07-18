import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

// Get all manhwa bookmarks for a specific user
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const bookmarks = await prisma.manhwaBookmark.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' }
    });
    res.json({ success: true, data: bookmarks });
  } catch (error) {
    console.error("Error fetching manhwa bookmarks:", error);
    res.status(500).json({ success: false, error: "Failed to fetch manhwa bookmarks" });
  }
});

// Add a new manhwa bookmark
router.post("/", async (req, res) => {
  try {
    const { userId, mangaId, title, coverImage, status } = req.body;
    
    if (!userId || !mangaId || !title) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

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
        updatedAt: new Date()
      },
      create: {
        userId,
        mangaId,
        title,
        coverImage,
        status: status || "READING"
      }
    });

    res.json({ success: true, data: bookmark });
  } catch (error) {
    console.error("Error creating manhwa bookmark:", error);
    res.status(500).json({ success: false, error: "Failed to create manhwa bookmark" });
  }
});

// Update a manhwa bookmark status
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    const bookmark = await prisma.manhwaBookmark.update({
      where: { id },
      data: { status }
    });
    
    res.json({ success: true, data: bookmark });
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
