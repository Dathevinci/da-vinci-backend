import { Router } from "express";
import { getCatalog, getCollection, openPack, dustCard, craftCard } from "../controllers/card.controller";

const router = Router();

router.get("/catalog", getCatalog);
router.get("/collection/:userId", getCollection);
router.post("/open-pack", openPack);
router.post("/dust", dustCard);
router.post("/craft", craftCard);

export default router;
