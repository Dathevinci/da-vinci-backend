import { Request, Response, NextFunction } from "express";
import { searchAnimeData } from "../services/anime.service";
import { anilistTotals, pageInfoOf } from "../utils/explorePaging";

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
    /**
     * Totals ride ALONGSIDE the existing envelope, never inside `data`.
     *
     * `data` is AniList's own payload passed through verbatim, and callers
     * already read `data.Page.pageInfo` — reshaping it to add totals would
     * break them for no gain. These are additive top-level fields, absent
     * whenever AniList didn't report a usable count, which is what lets the
     * client tell "unknown" apart from "one page".
     */
    res.json({ success: true, data, source: "AniList", cached, ...anilistTotals(pageInfoOf(data)) });
  } catch (error) {
    next(error);
  }
};
