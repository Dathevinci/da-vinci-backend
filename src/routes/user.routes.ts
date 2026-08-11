import { Router } from "express";
import { createUser, getUser, updateUser, deleteUser, getUserByUsername, getAllUsers, followUser, unfollowUser, getUserPointLogs, addXpForWatching, earnPoints, changeUsername } from "../controllers/user.controller";
import { getUserActivity, getUserActivityDay } from "../controllers/activity.controller";
import { getUserNotifications, markNotificationAsRead, markAllAsRead } from "../controllers/notification.controller";
import { giftItem, purchaseItem, purchaseBundle } from "../controllers/gift.controller";
import { getDailyQuests, claimDailyQuest } from "../controllers/quest.controller";
import { validateRequest } from "../middleware/validateRequest";
import { createUserSchema } from "../schemas/watchlist.schema";

const router = Router();

router.get("/username/:username", getUserByUsername);
router.get("/", getAllUsers);

// Shop transactions — server-authoritative (price + balance decided by the
// backend). Declared before the "/:id" routes so they're never read as an id.
router.post("/gift", giftItem);
router.post("/purchase", purchaseItem);
router.post("/purchase-bundle", purchaseBundle);

router.post("/", validateRequest(createUserSchema), createUser);
router.get("/:id", getUser);
router.get("/:id/point-logs", getUserPointLogs);

// Activity history (the profile contribution grid). Public reads, like
// /:id/point-logs directly above.
//
// ROUTE ORDER: the three-segment ":date" route is declared FIRST, ahead of the
// two-segment summary, so the specific pattern always gets first refusal —
// the same specific-before-general rule /gift and /:id/quests follow. Nothing
// above can swallow either one: every GET declared earlier is one segment
// ("/:id") or a two-segment path whose second segment is a LITERAL
// ("/point-logs", "/quests", "/notifications"), and a literal cannot match
// "activity". Nothing below can swallow them either — the remaining "/:id"
// routes are PATCH/DELETE/POST, not GET. Keep any future "/:id/:something"
// GET route (a param in the second slot) BELOW these two, or it will eat them.
router.get("/:id/activity/:date", getUserActivityDay);
router.get("/:id/activity", getUserActivity);
router.post("/:id/add-xp", addXpForWatching);
router.post("/:id/earn", earnPoints);

// Daily quests. More specific than "/:id", so declared before the bare
// PATCH/DELETE below for the same reason /gift and /purchase are hoisted.
router.get("/:id/quests", getDailyQuests);
router.post("/:id/quests/:questId/claim", claimDailyQuest);

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
