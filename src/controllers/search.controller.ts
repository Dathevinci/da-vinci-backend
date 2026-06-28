import { Request, Response, NextFunction } from "express";
import { searchAnimeData } from "../services/anime.service";

export const searchAnime = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, status, season, year, page } = req.query;

    const variables: any = { page };
    if (q) variables.search = q;
    if (status) variables.status = status;
    if (season) variables.season = season;
    if (year) variables.seasonYear = year;

    const { data, cached } = await searchAnimeData(variables);
    res.json({ success: true, data, source: "AniList", cached });
  } catch (error) {
    next(error);
  }
};
