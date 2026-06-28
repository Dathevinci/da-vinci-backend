import { anilistClient } from "../lib/anilistClient";

export const fetchFromAniList = async (query: string, variables: any = {}) => {
  try {
    const response = await anilistClient.post("", { query, variables });
    if (response.data.errors) {
      throw new Error(`AniList GraphQL Error: ${JSON.stringify(response.data.errors)}`);
    }
    return response.data.data;
  } catch (error: any) {
    console.error("AniList Fetch Error:", error.message || error);
    throw new Error("Failed to fetch data from AniList API");
  }
};

const AnimeCardFragment = `
  fragment AnimeCard on Media {
    id
    title { romaji english native }
    description(asHtml: false)
    coverImage { extraLarge large color }
    bannerImage
    format
    status(version: 2)
    episodes
    duration
    season
    seasonYear
    genres
    averageScore
    popularity
    nextAiringEpisode { airingAt timeUntilAiring episode }
    studios(isMain: true) { nodes { id name } }
  }
`;

export const queries = {
  getDashboard: `
    query Dashboard($season: MediaSeason, $year: Int, $nextSeason: MediaSeason, $nextYear: Int) {
      trending: Page(page: 1, perPage: 20) { media(type: ANIME, sort: TRENDING_DESC, isAdult: false) { ...AnimeCard } }
      airingNow: Page(page: 1, perPage: 20) { media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC, isAdult: false) { ...AnimeCard } }
      upcoming: Page(page: 1, perPage: 20) { media(type: ANIME, status: NOT_YET_RELEASED, sort: POPULARITY_DESC, isAdult: false) { ...AnimeCard } }
      thisSeason: Page(page: 1, perPage: 20) { media(type: ANIME, season: $season, seasonYear: $year, sort: POPULARITY_DESC, isAdult: false) { ...AnimeCard } }
      nextSeason: Page(page: 1, perPage: 20) { media(type: ANIME, season: $nextSeason, seasonYear: $nextYear, sort: POPULARITY_DESC, isAdult: false) { ...AnimeCard } }
      finished: Page(page: 1, perPage: 20) { media(type: ANIME, status: FINISHED, sort: POPULARITY_DESC, isAdult: false) { ...AnimeCard } }
    }
    ${AnimeCardFragment}
  `,
  getAnimeById: `
    query AnimeDetails($id: Int) {
      Media(id: $id, type: ANIME) {
        ...AnimeCard
        trailer { id site thumbnail }
        externalLinks { site url type }
      }
    }
    ${AnimeCardFragment}
  `,
  searchAnime: `
    query SearchAnime($page: Int, $search: String, $status: MediaStatus, $season: MediaSeason, $seasonYear: Int, $format: MediaFormat) {
      Page(page: $page, perPage: 50) {
        pageInfo { total currentPage lastPage hasNextPage }
        media(type: ANIME, search: $search, status: $status, season: $season, seasonYear: $seasonYear, format: $format, sort: POPULARITY_DESC, isAdult: false) {
          ...AnimeCard
        }
      }
    }
    ${AnimeCardFragment}
  `,
  getAiringSchedule: `
    query AiringSchedule($airingAt_greater: Int, $airingAt_lesser: Int) {
      Page(page: 1, perPage: 50) {
        airingSchedules(notYetAired: true, airingAt_greater: $airingAt_greater, airingAt_lesser: $airingAt_lesser, sort: TIME) {
          id
          airingAt
          episode
          media {
            id
            title { romaji english }
            coverImage { large }
          }
        }
      }
    }
  `
};
