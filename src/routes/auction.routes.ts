import { Router } from "express";
import {
  listAuctions,
  getAuction,
  createAuction,
  placeBid,
  cancelAuction,
} from "../controllers/auction.controller";

const router = Router();

router.get("/", listAuctions);
router.get("/:id", getAuction);
router.post("/", createAuction);           // LEAD DEV only (checked in-handler)
router.post("/:id/bid", placeBid);
router.post("/:id/cancel", cancelAuction);  // LEAD DEV only (checked in-handler)

export default router;
