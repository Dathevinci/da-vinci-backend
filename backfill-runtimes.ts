import { PrismaClient } from "@prisma/client";
import axios from "axios";

/**
 * Backfill `episodes` + `duration` on WatchlistItem rows that predate those
 * columns, so "Hours Watched" reflects a user's whole history instead of only
 * what they've tracked since the feature shipped.
 *
 * Self-contained ON PURPOSE: it imports nothing from src/. Root scripts run
 * under ts-node WITHOUT @types/node, so pulling in any src file that touches
 * `process.env` (config/env, lib/prisma…) would fail the build with TS2591.
 * The AniList GraphQL endpoint is public, so we hit it directly.
 *
 * Safe to run on every deploy: only touches rows still missing runtime, so once
 * history is filled it's a no-op. Never throws — a bad AniList day must not fail
 * the build; anything left null is simply retried next deploy.
 */

const prisma = new PrismaClient();
const ANILIST_URL = "https://graphql.anilist.co";

const RUNTIME_QUERY = `
  query Runtimes($ids: [Int]) {
    Page(page: 1, perPage: 50) {
      media(id_in: $ids, type: ANIME) { id episodes duration }
    }
  }
`;

const BATCH = 50;
const MAX_BATCHES = 20; // bound the deploy: 1,000 anime per run, rest next time

async function fetchRuntimes(ids: number[]): Promise<any[]> {
  const res = await axios.post(
    ANILIST_URL,
    { query: RUNTIME_QUERY, variables: { ids } },
    { headers: { "Content-Type": "application/json", Accept: "application/json" }, timeout: 15000 }
  );
  return res.data?.data?.Page?.media ?? [];
}

async function main() {
  // Anything missing EITHER field — a row can know its episode count but not its
  // duration, and it would otherwise ride the 24-min fallback forever. Ordered so
  // the MAX_BATCHES window is deterministic and always moves forward, instead of
  // re-chewing the same unfillable head (still-airing shows) every deploy.
  const rows = await prisma.watchlistItem.findMany({
    where: { OR: [{ episodes: null }, { duration: null }] },
    select: { anilistId: true },
    orderBy: { anilistId: "asc" },
  });

  const ids = [...new Set(rows.map((r) => r.anilistId))].filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) {
    console.log("Runtime backfill: nothing to do.");
    return;
  }
  console.log(`Runtime backfill: ${ids.length} anime to look up.`);

  let filled = 0;
  for (let i = 0; i < ids.length && i / BATCH < MAX_BATCHES; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    try {
      const media = await fetchRuntimes(batch);
      for (const m of media) {
        if (!m?.id) continue;
        // Write whatever AniList actually knows. A still-airing show has no
        // episode count yet but does have a duration — record that rather than
        // skipping the row entirely.
        const data: any = {};
        if (m.episodes) data.episodes = m.episodes;
        if (m.duration) data.duration = m.duration;
        if (!Object.keys(data).length) continue;

        const r = await prisma.watchlistItem.updateMany({
          where: { anilistId: m.id, OR: [{ episodes: null }, { duration: null }] },
          data,
        });
        filled += r.count;
      }
    } catch (err: any) {
      console.error(`Runtime backfill: batch at ${i} failed —`, err?.message || err);
    }
    await new Promise((r) => setTimeout(r, 1200)); // AniList allows ~90 req/min
  }

  console.log(`Runtime backfill: filled ${filled} watchlist row(s).`);
}

main()
  .catch((e) => console.error("Runtime backfill failed:", e))
  .finally(async () => {
    await prisma.$disconnect();
  });
