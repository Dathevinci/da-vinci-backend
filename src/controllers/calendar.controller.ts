import { Request, Response, NextFunction } from "express";
import { getCalendarData } from "../services/anime.service";

export const getCalendar = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, cached } = await getCalendarData();
    res.json({ success: true, data, source: "AniList", cached });
  } catch (error) {
    next(error);
  }
};

export const getCalendarToday = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, cached } = await getCalendarData();
    
    // Filter for only today
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const endOfDay = startOfDay + 86400;

    const todaySchedules = data?.Page?.airingSchedules?.filter((item: any) => 
      item.airingAt >= startOfDay && item.airingAt <= endOfDay
    ) || [];

    res.json({ success: true, data: todaySchedules, source: "AniList", cached });
  } catch (error) {
    next(error);
  }
};
