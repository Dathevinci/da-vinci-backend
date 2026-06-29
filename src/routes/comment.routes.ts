import { Router } from "express";
import { getComments, createComment, deleteComment, voteComment } from "../controllers/comment.controller";

const router = Router();

router.get("/", getComments);
router.post("/", createComment);
router.delete("/:id", deleteComment);
router.post("/:id/vote", voteComment);

export default router;
