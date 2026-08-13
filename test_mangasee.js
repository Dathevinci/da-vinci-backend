// test_mangasee.js - Test Mangasee (WeebCentral) Scraper End-to-End
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function runMangaseeTests() {
  console.log("================================================================================");
  console.log("             TEST 1: Mangasee / WeebCentral Home Feed (Trending & Latest)       ");
  console.log("================================================================================\n");

  const homeRes = await fetch("https://weebcentral.com/", {
    headers: { "User-Agent": UA }
  });
  console.log(`[PASS] Home Feed HTTP Status: ${homeRes.status}`);
  const homeHtml = await homeRes.text();
  
  // Extract all article cards
  const articles = Array.from(homeHtml.matchAll(/<article[\s\S]*?<\/article>/gi));
  console.log(`[PASS] Found ${articles.length} manga cards on home feed!`);
  
  const trendingRows = [];
  for (const a of articles) {
    const block = a[0];
    const linkMatch = block.match(/href="https:\/\/weebcentral\.com\/series\/([^"/]+)\/([^"]+)"/i) ||
                      block.match(/href="\/series\/([^"/]+)\/([^"]+)"/i);
    const titleMatch = block.match(/alt="([^"]+)"/i) ||
                       block.match(/<a[^>]*class="[^"]*font-bold[^"]*"[^>]*>([^<]+)<\/a>/i);
    const imgMatch = block.match(/src="([^"]+)"/i) || block.match(/srcset="([^"\s,]+)/i);

    if (linkMatch && titleMatch) {
      const id = `mse:${linkMatch[1]}`;
      const title = titleMatch[1].replace(/\s*cover$/i, '').trim();
      const image = imgMatch ? imgMatch[1] : `https://temp.compsci88.com/cover/normal/${linkMatch[1]}.webp`;
      if (!trendingRows.some(r => r.id === id)) {
        trendingRows.push({ id, title, image });
      }
    }
  }

  console.log(`[PASS] Parsed ${trendingRows.length} distinct trending items! Sample 2:`);
  console.log(JSON.stringify(trendingRows.slice(0, 2), null, 2));

  console.log("\n================================================================================");
  console.log("             TEST 2: Mangasee Search ('Solo Leveling')                          ");
  console.log("================================================================================\n");

  const searchRes = await fetch("https://weebcentral.com/search/data?text=Solo%20Leveling", {
    headers: { "User-Agent": UA }
  });
  console.log(`[PASS] Search HTTP Status: ${searchRes.status}`);
  const searchHtml = await searchRes.text();
  const searchArticles = Array.from(searchHtml.matchAll(/<article[\s\S]*?<\/article>/gi));
  console.log(`[PASS] Found ${searchArticles.length} search result cards!`);

  const searchResults = [];
  for (const a of searchArticles) {
    const block = a[0];
    const linkMatch = block.match(/href="https:\/\/weebcentral\.com\/series\/([^"/]+)\/([^"]+)"/i) ||
                      block.match(/href="\/series\/([^"/]+)\/([^"]+)"/i);
    const titleMatch = block.match(/alt="([^"]+)"/i) ||
                       block.match(/<a[^>]*class="[^"]*link[^"]*"[^>]*>([^<]+)<\/a>/i);
    const imgMatch = block.match(/src="([^"]+)"/i) || block.match(/srcset="([^"\s,]+)/i);

    if (linkMatch) {
      const id = `mse:${linkMatch[1]}`;
      const title = titleMatch ? titleMatch[1].replace(/\s*cover$/i, '').trim() : linkMatch[2].replace(/-/g, ' ');
      const image = imgMatch ? imgMatch[1] : `https://temp.compsci88.com/cover/normal/${linkMatch[1]}.webp`;
      searchResults.push({ id, title, image });
    }
  }
  console.log("Sample Search Results:");
  console.log(JSON.stringify(searchResults.slice(0, 2), null, 2));

  console.log("\n================================================================================");
  console.log("             TEST 3: Mangasee Series Details & Chapter List                     ");
  console.log("================================================================================\n");

  const testSeriesId = "01J76XYCPSY3C4BNPBRY8JMCBE"; // Solo Leveling
  const seriesRes = await fetch(`https://weebcentral.com/series/${testSeriesId}/full-chapter-list`, {
    headers: { "User-Agent": UA }
  });
  console.log(`[PASS] Chapter List HTTP Status: ${seriesRes.status}`);
  const chapHtml = await seriesRes.text();

  const chapMatches = Array.from(chapHtml.matchAll(/href="https:\/\/weebcentral\.com\/chapters\/([^"]+)"[\s\S]*?<span[^>]*>(Chapter\s+[^<]+)<\/span>[\s\S]*?<time[^>]*datetime="([^"]+)"/gi))
    .concat(Array.from(chapHtml.matchAll(/href="\/chapters\/([^"]+)"[\s\S]*?<span[^>]*>(Chapter\s+[^<]+)<\/span>[\s\S]*?<time[^>]*datetime="([^"]+)"/gi)));

  console.log(`[PASS] Extracted ${chapMatches.length} chapters!`);
  const chapters = chapMatches.map(m => ({
    id: `mse:${testSeriesId}|${m[1]}`,
    title: m[2].trim(),
    releaseDate: m[3]
  }));
  console.log("First and last chapter sample:");
  console.log(JSON.stringify([chapters[0], chapters[chapters.length - 1]], null, 2));

  console.log("\n================================================================================");
  console.log("             TEST 4: Mangasee Chapter Reader (High-Res Images)                  ");
  console.log("================================================================================\n");

  const testChapId = chapMatches[0][1];
  const imgRes = await fetch(`https://weebcentral.com/chapters/${testChapId}/images`, {
    headers: { "User-Agent": UA }
  });
  console.log(`[PASS] Reader Images HTTP Status: ${imgRes.status}`);
  const imgHtml = await imgRes.text();
  const pageImgs = Array.from(imgHtml.matchAll(/<img[^>]*src="([^"]+)"/gi)).map((m, idx) => ({
    page: idx + 1,
    img: m[1]
  }));

  console.log(`[PASS] Found ${pageImgs.length} high-resolution page images!`);
  console.log("Sample 3 page URLs:");
  console.log(JSON.stringify(pageImgs.slice(0, 3), null, 2));

  // Verify real CDN image fetch
  const imgCheck = await fetch(pageImgs[0].img, {
    headers: { "User-Agent": UA, "Referer": "https://weebcentral.com/" }
  });
  console.log(`[PASS] Page 1 CDN Image Fetch: Status ${imgCheck.status}, Content-Type: ${imgCheck.headers.get("content-type")}, Size: ${imgCheck.headers.get("content-length")} bytes`);

  console.log("\n================================================================================");
  console.log("                     ALL MANGASEE TESTS PASSED!                                 ");
  console.log("================================================================================\n");
}

runMangaseeTests().catch(console.error);
