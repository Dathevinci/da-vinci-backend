import { Router } from "express";
import { getAnnouncements, createAnnouncement, toggleLike, getComments, addComment, deleteComment, deleteAnnouncement, editAnnouncement, editComment } from "../controllers/announcement.controller";

const router = Router();

router.get("/", getAnnouncements);
router.post("/", createAnnouncement);
router.post("/:id/like", toggleLike);
router.get("/:id/comments", getComments);
router.post("/:id/comments", addComment);
router.delete("/comments/:commentId", deleteComment);
router.put("/comments/:commentId", editComment);
router.delete("/:id", deleteAnnouncement);
router.put("/:id", editAnnouncement);

export default router;
