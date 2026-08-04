import { Router } from "express";
import { votePoll } from "../controllers/comment.controller";

/**
 * Poll voting. Polls themselves are created as part of the post they belong
 * to (POST /api/comments with a `poll` body), so there is nothing to create
 * here — only a vote to cast or change.
 */
const router = Router();

router.post("/:id/vote", votePoll);

export default router;
