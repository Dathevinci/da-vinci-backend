import { Request, Response, NextFunction } from "express";
import { searchAnimeData } from "../services/anime.service";

export const searchAnime = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, status, season, year, page, genre, sort, format } = req.query;

    const variables: any = { page };
    if (q) variables.search = q;
    if (status) variables.status = status;
    if (season) variables.season = season;
    if (year) variables.seasonYear = year;
    if (format) variables.format = format;
    if (genre) {
      // API may send comma separated string "Action,Adventure"
      variables.genre_in = typeof genre === 'string' ? genre.split(',') : genre;
    }
    
    // Default sorting
    if (sort) {
      variables.sort = [sort];
    } else if (q) {
      variables.sort = ["SEARCH_MATCH", "POPULARITY_DESC"];
    } else {
      variables.sort = ["POPULARITY_DESC"];
    }

    const { data, cached } = await searchAnimeData(variables);
    res.json({ success: true, data, source: "AniList", cached });
  } catch (error) {
    next(error);
  }
};
