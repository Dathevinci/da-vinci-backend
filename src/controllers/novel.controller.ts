import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

export const getNovels = async (req: Request, res: Response) => {
  try {
    const title = req.query.title as string;
    
    const novels = await prisma.novel.findMany({
      where: title ? {
        title: {
          contains: title,
          mode: 'insensitive'
        }
      } : undefined,
      orderBy: { updatedAt: "desc" },
      include: {
        chapters: {
          select: { id: true, title: true, chapterNum: true, createdAt: true },
          orderBy: { chapterNum: "asc" },
        },
      },
    });
    res.json({ success: true, data: novels });
  } catch (error) {
    console.error("Error fetching novels:", error);
    res.status(500).json({ success: false, error: "Failed to fetch novels" });
  }
};

export const getNovelDetails = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const novel = await prisma.novel.findUnique({
      where: { id },
      include: {
        chapters: {
          select: { id: true, title: true, chapterNum: true, createdAt: true },
          orderBy: { chapterNum: "asc" },
        },
      },
    });

    if (!novel) return res.status(404).json({ success: false, error: "Novel not found" });

    res.json({ success: true, data: novel });
  } catch (error) {
    console.error("Error fetching novel details:", error);
    res.status(500).json({ success: false, error: "Failed to fetch novel details" });
  }
};

export const getChapter = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const chapterId = req.params.chapterId as string;
  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id: chapterId },
    });

    if (!chapter) {
      return res.status(404).json({ success: false, error: "Chapter not found" });
    }

    res.json({ success: true, data: chapter });
  } catch (error) {
    console.error("Error fetching chapter:", error);
    res.status(500).json({ success: false, error: "Failed to fetch chapter" });
  }
};

export const getBookmark = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const userId = req.params.userId as string;

  if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

  try {
    const bookmark = await prisma.novelBookmark.findUnique({
      where: { userId_novelId: { userId, novelId: id } },
    });

    res.json({ success: true, data: bookmark });
  } catch (error) {
    console.error("Error fetching bookmark:", error);
    res.status(500).json({ success: false, error: "Failed to fetch bookmark" });
  }
};

export const saveBookmark = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const chapterId = req.body.chapterId as string;
  const userId = req.body.userId as string;

  if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

  try {
    const bookmark = await prisma.novelBookmark.upsert({
      where: { userId_novelId: { userId, novelId: id } },
      update: { lastReadChapter: chapterId },
      create: { userId, novelId: id, lastReadChapter: chapterId },
    });

    res.json({ success: true, data: bookmark });
  } catch (error) {
    console.error("Error saving bookmark:", error);
    res.status(500).json({ success: false, error: "Failed to save bookmark" });
  }
};
