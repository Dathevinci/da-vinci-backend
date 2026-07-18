import { Router } from "express";
import { getDashboard } from "../controllers/dashboard.controller";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

router.get("/", apiLimiter, getDashboard);

export default router;
