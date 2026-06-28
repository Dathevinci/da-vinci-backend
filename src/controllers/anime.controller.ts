import { Request, Response, NextFunction } from "express";
import { getAnimeDetails, getAnimeByStatus } from "../services/anime.service";

export const getDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const { data, cached } = await getAnimeDetails(id);
    res.json({ success: true, data, source: "AniList", cached });
  } catch (error) {
    next(error);
  }
};

export const getByStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = (req.params.status as string).toUpperCase();
    const page = parseInt(req.query.page as string) || 1;

    const validStatuses = ["RELEASING", "NOT_YET_RELEASED", "FINISHED", "CANCELLED", "HIATUS"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const { data, cached } = await getAnimeByStatus(status, page);
    res.json({ success: true, data, source: "AniList", cached });
  } catch (error) {
    next(error);
  }
};
