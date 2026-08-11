import { Router } from "express";
import { chatLimiter } from "../middleware/rateLimiter";
import { listMessages, messagesHead, postMessage, editMessage, deleteMessage } from "../controllers/guildChat.controller";

const router = Router();

// Mounted at /api/guilds ABOVE the global limiter (see app.ts for why). This
// router carries ONLY the /messages paths — none of them collide with the
// main guild router's routes, and anything that doesn't match here falls
// through to that router's mount below the limiter.
//
// chatLimiter sits on the ROUTES, not the mount: mount-level middleware runs
// for every /api/guilds request before route matching, so browse/join/kick
// traffic would burn the chat budget and could be 429'd by it.
//
// /:id/messages/head registers before /:id/messages/:messageId. DELETE and
// PATCH are different verbs from GET, so there is no live collision today —
// the ordering is kept specific-before-param so adding any GET to the
// :messageId route can't swallow "head" as a message id.
router.get("/:id/messages", chatLimiter, listMessages);
router.get("/:id/messages/head", chatLimiter, messagesHead);
router.post("/:id/messages", chatLimiter, postMessage);
router.patch("/:id/messages/:messageId", chatLimiter, editMessage);
router.delete("/:id/messages/:messageId", chatLimiter, deleteMessage);

export default router;
