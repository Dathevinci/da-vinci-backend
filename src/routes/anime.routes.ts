import { Router } from "express";
import { getDetails, getByStatus } from "../controllers/anime.controller";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

router.get("/status/:status", apiLimiter, getByStatus);
router.get("/:id", apiLimiter, getDetails);

export default router;
