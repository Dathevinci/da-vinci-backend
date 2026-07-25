import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireStaff } from "../lib/staff";

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
    const { enabled } = req.body;

    // Lead-Dev only, proven by the VERIFIED token.
    //
    // This previously compared a plaintext `username` string from the request
    // BODY against "dejavuh" — no token, no lookup — so a single unauthenticated
    // curl could take the whole site down (or quietly lift a lockdown).
    const actor = await requireStaff(req, res, { leadDevOnly: true });
    if (!actor) return;

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
