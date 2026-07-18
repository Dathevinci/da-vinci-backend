import { Request, Response, NextFunction } from "express";
import { getDashboardData } from "../services/anime.service";

export const getDashboard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, cached } = await getDashboardData();
    res.json({
      success: true,
      data,
      source: "AniList",
      cached,
    });
  } catch (error) {
    next(error);
  }
};
