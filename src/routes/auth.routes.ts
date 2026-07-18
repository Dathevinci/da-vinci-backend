import { Router } from "express";
import { signup, login, changePassword } from "../controllers/auth.controller";
import { authLimiter } from "../middleware/rateLimiter";

const router = Router();

router.post("/signup", authLimiter, signup);
router.post("/login", authLimiter, login);
router.post("/change-password", authLimiter, changePassword);

export default router;
