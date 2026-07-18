import { Router } from "express";
import { getNovels, getNovelDetails, getChapter, getBookmark, saveBookmark } from "../controllers/novel.controller";

const router = Router();

// Public routes
router.get("/", getNovels);
router.get("/:id", getNovelDetails);
router.get("/:id/chapter/:chapterId", getChapter);

// Protected routes for reading progress (expect userId in params/body instead of auth token)
router.get("/:id/bookmark/:userId", getBookmark);
router.post("/:id/bookmark", saveBookmark);

export default router;
