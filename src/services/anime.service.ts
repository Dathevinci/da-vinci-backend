import { fetchFromAniList, queries } from "./anilist.service";
import { getCache, setCache } from "./cache.service";
import { getCurrentSeasonInfo } from "../utils/season";

// Helper to wrap cache logic
const withCache = async (key: string, ttl: number, fetcher: () => Promise<any>) => {
  const cached = await getCache(key);
  if (cached) return { data: cached, cached: true };

  const data = await fetcher();
  await setCache(key, data, ttl);
  return { data, cached: false };
};

export const getDashboardData = async () => {
  const cacheKey = "dashboard_data";
  const ttl = 15 * 60; // 15 mins

  return withCache(cacheKey, ttl, async () => {
    const { season, year, nextSeason, nextYear } = getCurrentSeasonInfo();
    return fetchFromAniList(queries.getDashboard, { season, year, nextSeason, nextYear });
  });
};

export const getAnimeDetails = async (id: number) => {
  const cacheKey = `anime_${id}`;
  const ttl = 60 * 60; // 1 hour

  return withCache(cacheKey, ttl, async () => {
    const data = await fetchFromAniList(queries.getAnimeById, { id });
    return data.Media;
  });
};

export const getAnimeByStatus = async (status: string, page = 1) => {
  const cacheKey = `anime_status_${status}_${page}`;
  const ttl = 10 * 60; // 10 mins

  return withCache(cacheKey, ttl, async () => {
    return fetchFromAniList(queries.searchAnime, { status, page });
  });
};

export const searchAnimeData = async (variables: any) => {
  const cacheKey = `search_${JSON.stringify(variables)}`;
  const ttl = 10 * 60; // 10 mins

  return withCache(cacheKey, ttl, async () => {
    return fetchFromAniList(queries.searchAnime, variables);
  });
};

export const getCalendarData = async () => {
  const cacheKey = "calendar_7days";
  const ttl = 5 * 60; // 5 mins

  return withCache(cacheKey, ttl, async () => {
    const now = Math.floor(Date.now() / 1000);
    const nextWeek = now + 7 * 24 * 60 * 60;
    return fetchFromAniList(queries.getAiringSchedule, {
      airingAt_greater: now,
      airingAt_lesser: nextWeek,
    });
  });
};
