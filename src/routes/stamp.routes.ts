import { Router } from "express";
import {
  getStamp,
  getRankings,
  getEndorsements,
  getFeed,
  getRecentRecs,
  getStampersFor,
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
// The two discovery reads. "recent" is a literal segment and would be read as a
// userId by the wildcard below — the board's exact incident — so it belongs
// here, above it. "/for/:mediaType/:mediaId" is three segments and could not be
// swallowed by a one-segment wildcard, but it is registered alongside its twin
// rather than left below on that reasoning: the next path added under /for
// might not be, and the rule "literals before the wildcard" is worth more than
// the exception.
router.get("/recent", getRecentRecs);
router.get("/for/:mediaType/:mediaId", getStampersFor);

// Recommendation writes live under /recs so they never collide with /:userId.
router.post("/recs", createRec);
router.delete("/recs/:recId", retireRec);
// The vote gate: /open must be called before /vote will accept a verdict.
router.post("/recs/:recId/open", openRec);
router.post("/recs/:recId/vote", voteRec);

router.get("/:userId", getStamp);
router.post("/:userId/boost", boostStamp);

export default router;
