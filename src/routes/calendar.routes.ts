import { Router } from "express";
import { getCalendar, getCalendarToday } from "../controllers/calendar.controller";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

router.get("/", apiLimiter, getCalendar);
router.get("/today", apiLimiter, getCalendarToday);

export default router;
