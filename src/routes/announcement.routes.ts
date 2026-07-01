import { Router } from "express";
import { getAnnouncements, createAnnouncement, toggleLike, getComments, addComment, deleteComment, deleteAnnouncement } from "../controllers/announcement.controller";

const router = Router();

router.get("/", getAnnouncements);
router.post("/", createAnnouncement);
router.post("/:id/like", toggleLike);
router.get("/:id/comments", getComments);
router.post("/:id/comments", addComment);
router.delete("/comments/:commentId", deleteComment);
router.delete("/:id", deleteAnnouncement);

export default router;
