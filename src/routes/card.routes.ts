import { Router } from "express";
import {
  getCatalog, getCollection, getCollectors, openPack, dustCard, craftCard,
  foilCard, openRelicPack, claimSet,
} from "../controllers/card.controller";

const router = Router();

router.get("/catalog", getCatalog);
router.get("/collectors", getCollectors);
router.get("/collection/:userId", getCollection);
router.post("/open-pack", openPack);
router.post("/dust", dustCard);
router.post("/craft", craftCard);
router.post("/foil", foilCard);
router.post("/relic-pack", openRelicPack);
router.post("/claim-set", claimSet);

export default router;
