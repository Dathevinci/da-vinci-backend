import { Router } from "express";
import { getComments, createComment, deleteComment, voteComment, editComment, togglePinComment, tipComment, blessComment, getForumTopics, reportComment, getCommentById } from "../controllers/comment.controller";

const router = Router();

router.get("/topics", getForumTopics);
router.get("/", getComments);
// AFTER the literal routes above, so "/topics" is never read as an id.
router.get("/:id", getCommentById);
router.post("/", createComment);
router.delete("/:id", deleteComment);
router.put("/:id", editComment);
router.put("/:id/pin", togglePinComment);
router.post("/:id/vote", voteComment);
router.post("/:id/tip", tipComment);
router.post("/:id/bless", blessComment);
router.post("/:id/report", reportComment);

export default router;
