import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const getSystemStatus = async (req: Request, res: Response) => {
  try {
    const maintenanceCache = await prisma.cacheItem.findUnique({
      where: { key: "MAINTENANCE_MODE" }
    });
    
    // Check if the data is explicitly "true"
    const isMaintenance = maintenanceCache?.data === "true";

    res.json({ success: true, maintenance: isMaintenance });
  } catch (error) {
    console.error("Status check error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch status" });
  }
};

export const setSystemMaintenance = async (req: Request, res: Response) => {
  try {
    const { enabled, username } = req.body;

    // Strict security check
    if (username?.toLowerCase() !== "dejavuh") {
      return res.status(403).json({ success: false, message: "Unauthorized access" });
    }

    // Upsert the cache item so it persists through backend restarts
    await prisma.cacheItem.upsert({
      where: { key: "MAINTENANCE_MODE" },
      update: {
        data: enabled ? "true" : "false",
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 10) // 10 years
      },
      create: {
        key: "MAINTENANCE_MODE",
        data: enabled ? "true" : "false",
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 10) // 10 years
      }
    });

    res.json({ success: true, maintenance: enabled });
  } catch (error) {
    console.error("Set maintenance error:", error);
    res.status(500).json({ success: false, message: "Failed to update maintenance mode" });
  }
};
