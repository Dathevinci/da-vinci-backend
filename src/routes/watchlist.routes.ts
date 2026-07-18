import { Router } from "express";
import { addToWatchlist, getWatchlist, updateWatchlistItem, deleteWatchlistItem } from "../controllers/watchlist.controller";
import { validateRequest } from "../middleware/validateRequest";
import { addWatchlistSchema, updateWatchlistSchema } from "../schemas/watchlist.schema";

const router = Router();

router.post("/", validateRequest(addWatchlistSchema), addToWatchlist);
router.get("/:userId", getWatchlist);
router.patch("/:id", validateRequest(updateWatchlistSchema), updateWatchlistItem);
router.delete("/:id", deleteWatchlistItem);

export default router;
