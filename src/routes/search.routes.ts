import { Router } from "express";
import { searchAnime } from "../controllers/search.controller";
import { validateRequest } from "../middleware/validateRequest";
import { searchSchema } from "../schemas/search.schema";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

router.get("/", apiLimiter, validateRequest(searchSchema), searchAnime);

export default router;
