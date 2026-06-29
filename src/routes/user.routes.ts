import { Router } from "express";
import { createUser, getUser, updateUser, deleteUser, getUserByUsername, getAllUsers, followUser, unfollowUser } from "../controllers/user.controller";
import { getUserNotifications, markNotificationAsRead, markAllAsRead } from "../controllers/notification.controller";
import { validateRequest } from "../middleware/validateRequest";
import { createUserSchema } from "../schemas/watchlist.schema";

const router = Router();

router.get("/username/:username", getUserByUsername);
router.get("/", getAllUsers);

router.post("/", validateRequest(createUserSchema), createUser);
router.get("/:id", getUser);
router.patch("/:id", updateUser);
router.delete("/:id", deleteUser);

router.post("/:id/follow", followUser);
router.delete("/:id/follow", unfollowUser);

// Notification routes
router.get("/:userId/notifications", getUserNotifications);
router.post("/notifications/:id/read", markNotificationAsRead);
router.post("/:userId/notifications/read-all", markAllAsRead);

export default router;
