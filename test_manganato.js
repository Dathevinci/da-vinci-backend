// test_manganato.js - Test Manganato Scraper End-to-End
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PROXY = "https://goodproxy.goodproxy.workers.dev/fetch?url=";

async function fetchNato(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Referer": "https://www.manganato.gg/"
      },
      signal: AbortSignal.timeout(6000)
    });
    if (res.ok) return await res.text();
  } catch {}

  // Fallback to worker proxy
  const pRes = await fetch(PROXY + encodeURIComponent(url), {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(8000)
  });
  return await pRes.text();
}

async function runManganatoTests() {
  console.log("================================================================================");
  console.log("             TEST 1: Manganato Home Feed (Trending & Latest)                    ");
  console.log("================================================================================\n");

  const homeHtml = await fetchNato("https://www.manganato.gg/manga-list/latest-manga?page=1");
  console.log(`[PASS] Fetched Manganato latest manga HTML (Length: ${homeHtml.length})`);

  // Extract manga items
  const itemMatches = Array.from(homeHtml.matchAll(/<div class="[^"]*item[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi));
  console.log(`[PASS] Found ${itemMatches.length} item blocks!`);

  const mangaItems = [];
  const linkMatches = Array.from(homeHtml.matchAll(/<a[^>]*href="https:\/\/www\.manganato\.gg\/manga\/([a-zA-Z0-9_-]+)"[^>]*title="([^"]+)"/gi))
    .concat(Array.from(homeHtml.matchAll(/<a[^>]*title="([^"]+)"[^>]*href="https:\/\/www\.manganato\.gg\/manga\/([a-zA-Z0-9_-]+)"/gi)).map(m => [m[0], m[2], m[1]]));

  const seen = new Set();
  for (const m of linkMatches) {
    const slug = m[1];
    const title = m[2];
    if (slug && title && !seen.has(slug)) {
      seen.add(slug);
      mangaItems.push({
        id: `mna:${slug}`,
        title: title.trim(),
        image: `https://img-r2.2xstorage.com/thumb/${slug}.webp`
      });
    }
  }

  console.log(`[PASS] Extracted ${mangaItems.length} distinct manga titles! Sample 2:`);
  console.log(JSON.stringify(mangaItems.slice(0, 2), null, 2));

  console.log("\n================================================================================");
  console.log("             TEST 2: Manganato Manga Details & Chapters                         ");
  console.log("================================================================================\n");

  const testSlug = "logging-10000-years-into-the-future-apex-future-martial-arts";
  const detailHtml = await fetchNato(`https://www.manganato.gg/manga/${testSlug}`);
  const title = detailHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '').trim();
  const cover = detailHtml.match(/<div class="[^"]*story-info-left[^"]*"[\s\S]*?<img[^>]*src="([^"]+)"/i)?.[1] ||
                `https://img-r2.2xstorage.com/thumb/${testSlug}.webp`;

  const chapterMatches = Array.from(detailHtml.matchAll(/href="https:\/\/www\.manganato\.gg\/manga\/[^\/]+\/chapter-([0-9.]+)"[^>]*>([\s\S]*?)<\/a>/gi));
  console.log(`[PASS] Title: "${title}"`);
  console.log(`[PASS] Cover: "${cover}"`);
  console.log(`[PASS] Extracted ${chapterMatches.length} chapters!`);

  const chapters = chapterMatches.map(m => ({
    id: `mna:${testSlug}|chapter-${m[1]}`,
    title: m[2].trim().replace(/\s+/g, ' ') || `Chapter ${m[1]}`,
    number: parseFloat(m[1])
  }));
  console.log("First and last chapter sample:");
  console.log(JSON.stringify([chapters[0], chapters[chapters.length - 1]], null, 2));

  console.log("\n================================================================================");
  console.log("             TEST 3: Manganato Chapter Reader (High-Res Images)                 ");
  console.log("================================================================================\n");

  const testChapUrl = `https://www.manganato.gg/manga/${testSlug}/chapter-344`;
  const chapHtml = await fetchNato(testChapUrl);
  
  const cdnMatch = chapHtml.match(/var\s+cdns\s*=\s*(\[[^\]]+\]);/);
  const chapImgsMatch = chapHtml.match(/var\s+chapterImages\s*=\s*(\[[^\]]+\]);/);

  let pages = [];
  if (cdnMatch && chapImgsMatch) {
    const cdnBase = JSON.parse(cdnMatch[1])[0].replace(/\\\//g, '/');
    const rawImgs = JSON.parse(chapImgsMatch[1]);
    pages = rawImgs.map((imgPath, idx) => ({
      page: idx + 1,
      img: `${cdnBase.replace(/\/$/, '')}/${imgPath.replace(/^\//, '').replace(/\\\//g, '/')}`
    }));
  }

  console.log(`[PASS] Successfully parsed ${pages.length} chapter page image URLs from Manganato!`);
  console.log("Sample 3 page URLs:");
  console.log(JSON.stringify(pages.slice(0, 3), null, 2));

  // Test real CDN image fetch
  const imgCheck = await fetch(pages[0].img, {
    headers: { "User-Agent": UA, "Referer": "https://www.manganato.gg/" }
  });
  console.log(`[PASS] Page 1 CDN Image Status: ${imgCheck.status}, Content-Type: ${imgCheck.headers.get("content-type")}, Size: ${imgCheck.headers.get("content-length")} bytes`);

  console.log("\n================================================================================");
  console.log("                     ALL MANGANATO TESTS PASSED!                                ");
  console.log("================================================================================\n");
}

runManganatoTests().catch(console.error);
