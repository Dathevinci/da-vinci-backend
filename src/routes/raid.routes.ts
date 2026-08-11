import { Router } from "express";
import { getRaid, getGuildRaid, raidAttack, raidLeaderboard, raidHistory } from "../controllers/raid.controller";

const router = Router();

// The weekly world boss. GET lazily spawns the week (and settles the last
// one); attack is hard-JWT-gated inside the controller.
router.get("/", getRaid);
router.post("/attack", raidAttack);
router.get("/leaderboard", raidLeaderboard);
router.get("/history", raidHistory);
// Public read of ONE guild's current encounter, for the guild page's boss
// panel; 404s before ensureWeek so a garbage id never spawns a fight.
router.get("/guild/:guildId", getGuildRaid);

export default router;
