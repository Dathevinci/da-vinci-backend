import { Router } from "express";
import { createUser, getUser, updateUser, getUserByUsername, getAllUsers, followUser, unfollowUser } from "../controllers/user.controller";
import { validateRequest } from "../middleware/validateRequest";
import { createUserSchema } from "../schemas/watchlist.schema";

const router = Router();

router.get("/username/:username", getUserByUsername);
router.get("/", getAllUsers);

router.post("/", validateRequest(createUserSchema), createUser);
router.get("/:id", getUser);
router.patch("/:id", updateUser);

router.post("/:id/follow", followUser);
router.delete("/:id/follow", unfollowUser);

export default router;
