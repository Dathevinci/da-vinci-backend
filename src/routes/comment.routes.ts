import { Router } from "express";
import { getComments, createComment, deleteComment, voteComment, editComment, togglePinComment, tipComment, blessComment } from "../controllers/comment.controller";

const router = Router();

router.get("/", getComments);
router.post("/", createComment);
router.delete("/:id", deleteComment);
router.put("/:id", editComment);
router.put("/:id/pin", togglePinComment);
router.post("/:id/vote", voteComment);
router.post("/:id/tip", tipComment);
router.post("/:id/bless", blessComment);

export default router;
