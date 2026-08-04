import { Router } from "express";
import {
  getCatalog, getCollection, getCollectors, openPack, dustCard, craftCard,
  foilCard, openRelicPack, claimSet, getLadder, setShowcase, wakeCard, upgradeCard, upgradeSkill, attuneCard, forgeCard,
  getPullStats, getTitles, setTitles, dustAllDupes, grantAllCards, maxCard,
} from "../controllers/card.controller";

const router = Router();

router.get("/catalog", getCatalog);
router.get("/pull-stats", getPullStats);
router.get("/collectors", getCollectors);
router.get("/collection/:userId", getCollection);
router.post("/open-pack", openPack);
router.post("/dust", dustCard);
router.post("/dust-all", dustAllDupes);
router.post("/grant-all", grantAllCards);
// RETIRED with the card wipe: FUSIONS mapped legendary pairs to Mythics and
// every card on both sides is gone. The route is removed so the endpoint is
// unreachable rather than throwing on a catalogue that no longer has them.
// router.post("/synthesize", synthesizeMythic);
router.post("/max", maxCard);
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
