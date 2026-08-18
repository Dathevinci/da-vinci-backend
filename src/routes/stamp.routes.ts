import { Router } from "express";
import {
  getStamp,
  getRankings,
  getEndorsements,
  getFeed,
  createRec,
  retireRec,
  openRec,
  voteRec,
  boostStamp,
} from "../controllers/stamp.controller";

const router = Router();

// ORDER MATTERS. "rankings", "endorsements" and "feed" are literal paths that
// would otherwise be swallowed by GET /:userId — a request for the board would
// come back as "user not found" for a member whose id is the word "rankings".
router.get("/rankings", getRankings);
// Public, unauthenticated: the podium's picks decorate covers for signed-out
// visitors too, so no auth middleware belongs on this line.
router.get("/endorsements", getEndorsements);
router.get("/feed", getFeed);

// Recommendation writes live under /recs so they never collide with /:userId.
router.post("/recs", createRec);
router.delete("/recs/:recId", retireRec);
// The vote gate: /open must be called before /vote will accept a verdict.
router.post("/recs/:recId/open", openRec);
router.post("/recs/:recId/vote", voteRec);

router.get("/:userId", getStamp);
router.post("/:userId/boost", boostStamp);

export default router;
