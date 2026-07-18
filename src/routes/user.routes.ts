import { Router } from "express";
import { createUser, getUser, updateUser, deleteUser, getUserByUsername, getAllUsers, followUser, unfollowUser, getUserPointLogs, addXpForWatching, changeUsername } from "../controllers/user.controller";
import { getUserNotifications, markNotificationAsRead, markAllAsRead } from "../controllers/notification.controller";
import { giftItem } from "../controllers/gift.controller";
import { validateRequest } from "../middleware/validateRequest";
import { createUserSchema } from "../schemas/watchlist.schema";

const router = Router();

router.get("/username/:username", getUserByUsername);
router.get("/", getAllUsers);

// Gift a shop item to another user with your own Arise Points. Declared before
// the "/:id" routes so "gift" is never mistaken for a user id.
router.post("/gift", giftItem);

router.post("/", validateRequest(createUserSchema), createUser);
router.get("/:id", getUser);
router.get("/:id/point-logs", getUserPointLogs);
router.post("/:id/add-xp", addXpForWatching);
router.patch("/:id/username", changeUsername);
router.patch("/:id", updateUser);
router.delete("/:id", deleteUser);

router.post("/:id/follow", followUser);
router.delete("/:id/follow", unfollowUser);

// Notification routes
router.get("/:userId/notifications", getUserNotifications);
router.post("/notifications/:id/read", markNotificationAsRead);
router.post("/:userId/notifications/read-all", markAllAsRead);

export default router;
