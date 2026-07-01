import { Router } from "express";
import { signup, login, discordLogin, discordCallback } from "../controllers/auth.controller";

const router = Router();

router.post("/signup", signup);
router.post("/login", login);
router.get("/discord/login", discordLogin);
router.get("/discord/callback", discordCallback);

export default router;
