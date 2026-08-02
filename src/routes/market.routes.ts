import { Router } from "express";
import {
  listListings, createListing, buyListing, cancelListing,
} from "../controllers/market.controller";

const router = Router();

router.get("/", listListings);
router.post("/", createListing);
router.post("/:id/buy", buyListing);
router.post("/:id/cancel", cancelListing);

export default router;
