import { Router } from "express";
import {
  leaderboard, myDuels, getDuel, createDuel, acceptDuel, declineDuel, makeMove, buyItem,
  forfeitDuel,
} from "../controllers/duel.controller";

const router = Router();

router.get("/leaderboard", leaderboard);
router.get("/mine/:userId", myDuels);
router.post("/buy-item", buyItem);
router.post("/", createDuel);
router.get("/:id", getDuel);
router.post("/:id/accept", acceptDuel);
router.post("/:id/decline", declineDuel);
router.post("/:id/move", makeMove);
router.post("/:id/forfeit", forfeitDuel);

export default router;
