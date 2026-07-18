import { Router } from "express";
import { getUserNotifications, markAllAsRead, markNotificationAsRead } from "../controllers/notification.controller";
import { prisma } from "../lib/prisma";

const router = Router();

router.get("/:userId", getUserNotifications);
router.put("/:userId/readAll", markAllAsRead);
router.put("/:id/read", markNotificationAsRead);

// I will also add a clear endpoint here just in case
router.delete("/:userId/clearAll", async (req, res, next) => {
  try {
    await prisma.notification.deleteMany({
      where: { userId: req.params.userId }
    });
    res.json({ success: true, message: "All notifications cleared" });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.notification.delete({
      where: { id: req.params.id }
    });
    res.json({ success: true, message: "Notification deleted" });
  } catch (error) {
    next(error);
  }
});

export default router;
