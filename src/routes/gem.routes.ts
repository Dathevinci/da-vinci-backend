import { Router } from "express";
import { getGems, castGemVote } from "../controllers/gem.controller";

const router = Router();

// Standings for a mode: this week's tally, last week's winner, your own pick.
router.get("/", getGems);
// Cast or move this week's pick. Identity comes from the token inside.
router.post("/", castGemVote);

export default router;
