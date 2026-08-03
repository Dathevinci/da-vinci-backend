import { Router } from "express";
import {
  getCatalog, getCollection, getCollectors, openPack, dustCard, craftCard,
  foilCard, openRelicPack, claimSet, getLadder, setShowcase, wakeCard, upgradeCard, upgradeSkill, attuneCard, forgeCard,
  getPullStats, getTitles, setTitles, dustAllDupes,
} from "../controllers/card.controller";

const router = Router();

router.get("/catalog", getCatalog);
router.get("/pull-stats", getPullStats);
router.get("/collectors", getCollectors);
router.get("/collection/:userId", getCollection);
router.post("/open-pack", openPack);
router.post("/dust", dustCard);
router.post("/dust-all", dustAllDupes);
router.post("/craft", craftCard);
router.post("/foil", foilCard);
router.post("/relic-pack", openRelicPack);
router.post("/claim-set", claimSet);
router.get("/ladder", getLadder);
router.put("/showcase", setShowcase);
router.get("/titles/:userId", getTitles);
router.put("/titles", setTitles);
router.post("/wake", wakeCard);
router.post("/upgrade", upgradeCard);
router.post("/forge", forgeCard);
router.post("/upgrade-skill", upgradeSkill);
router.post("/attune", attuneCard);

export default router;
