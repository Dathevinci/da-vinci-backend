import { Router } from "express";
import { getRaid, raidAttack, raidLeaderboard, raidHistory } from "../controllers/raid.controller";

const router = Router();

// The weekly world boss. GET lazily spawns the week (and settles the last
// one); attack is hard-JWT-gated inside the controller.
router.get("/", getRaid);
router.post("/attack", raidAttack);
router.get("/leaderboard", raidLeaderboard);
router.get("/history", raidHistory);

export default router;
