import { Router } from "express";
import { createUser, getUser } from "../controllers/user.controller";
import { validateRequest } from "../middleware/validateRequest";
import { createUserSchema } from "../schemas/watchlist.schema";

const router = Router();

router.post("/", validateRequest(createUserSchema), createUser);
router.get("/:id", getUser);

export default router;
