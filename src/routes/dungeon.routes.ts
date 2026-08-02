import { Router } from "express";
import {
  getStatus, dispatch, advance, recall, healCard, reviveCard,
} from "../controllers/dungeon.controller";

const router = Router();

// Literal paths BEFORE parameterized ones — /:id swallows everything else.
router.get("/status/:userId", getStatus);
router.post("/heal", healCard);
router.post("/revive", reviveCard);
router.post("/", dispatch);
router.post("/:id/advance", advance);
router.post("/:id/recall", recall);

export default router;
