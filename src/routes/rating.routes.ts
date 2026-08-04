import { Router } from "express";
import { getRating, setRating } from "../controllers/comment.controller";

/**
 * Member scores for anything with a page: an anime, a manhwa series or one
 * of its chapters, a novel, an episode. One opaque `targetKey` keeps it to
 * a single table and a single pair of endpoints.
 */
const router = Router();

router.get("/", getRating);
router.post("/", setRating);

export default router;
