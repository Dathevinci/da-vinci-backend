import { Router } from "express";
import { getComments, createComment, deleteComment, voteComment, editComment } from "../controllers/comment.controller";

const router = Router();

router.get("/", getComments);
router.post("/", createComment);
router.delete("/:id", deleteComment);
router.put("/:id", editComment);
router.post("/:id/vote", voteComment);

export default router;
