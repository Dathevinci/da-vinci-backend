import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

export const getUserNotifications = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.params.userId as string },
      orderBy: { createdAt: 'desc' },
      include: {
        actor: {
          select: { id: true, username: true, avatar: true }
        }
      }
    });
    res.json({ success: true, data: notifications });
  } catch (error) {
    next(error);
  }
};

export const markNotificationAsRead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notification = await prisma.notification.update({
      where: { id: req.params.id as string },
      data: { isRead: true }
    });
    res.json({ success: true, data: notification });
  } catch (error) {
    next(error);
  }
};

export const markAllAsRead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.params.userId as string, isRead: false },
      data: { isRead: true }
    });
    res.json({ success: true, message: "All notifications marked as read" });
  } catch (error) {
    next(error);
  }
};
