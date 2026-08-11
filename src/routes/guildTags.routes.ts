import { Router } from "express";
import { tagLimiter } from "../middleware/rateLimiter";
import { guildTags } from "../controllers/guild.controller";

const router = Router();

// Mounted at /api/guilds ABOVE the global limiter (see app.ts for why). This
// router carries ONLY POST /tags — a static path no route in the main guild
// router claims, and anything that doesn't match here falls through to that
// router's mount below the limiter.
//
// tagLimiter sits on the ROUTE, not the mount: mount-level middleware runs for
// every /api/guilds request before route matching, so browse/join/kick traffic
// would burn the tag budget and could be 429'd by it — the same mistake the
// chat mount already had to fix.
router.post("/tags", tagLimiter, guildTags);

export default router;
