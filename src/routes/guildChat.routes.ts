import { Router } from "express";
import { chatLimiter } from "../middleware/rateLimiter";
import { listMessages, postMessage, deleteMessage } from "../controllers/guildChat.controller";

const router = Router();

// Mounted at /api/guilds ABOVE the global limiter (see app.ts for why). This
// router carries ONLY the three /messages paths — none of them collide with
// the main guild router's routes, and anything that doesn't match here falls
// through to that router's mount below the limiter.
//
// chatLimiter sits on the ROUTES, not the mount: mount-level middleware runs
// for every /api/guilds request before route matching, so browse/join/kick
// traffic would burn the chat budget and could be 429'd by it.
router.get("/:id/messages", chatLimiter, listMessages);
router.post("/:id/messages", chatLimiter, postMessage);
router.delete("/:id/messages/:messageId", chatLimiter, deleteMessage);

export default router;
