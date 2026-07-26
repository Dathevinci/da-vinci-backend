import { Router } from "express";
import { addToWatchlist, getWatchlist, updateWatchlistItem, deleteWatchlistItem, saveWatchProgress } from "../controllers/watchlist.controller";
import { validateRequest } from "../middleware/validateRequest";
import { addWatchlistSchema, updateWatchlistSchema } from "../schemas/watchlist.schema";

const router = Router();

router.post("/", validateRequest(addWatchlistSchema), addToWatchlist);
// Literal segment declared BEFORE "/:userId" and "/:id" so it's never read as an id.
router.post("/progress", saveWatchProgress);
router.get("/:userId", getWatchlist);
router.patch("/:id", validateRequest(updateWatchlistSchema), updateWatchlistItem);
router.delete("/:id", deleteWatchlistItem);

export default router;
