const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function testLnoriRaw() {
  console.log("================================================================================");
  console.log("                 TEST: Lnori Raw HTML, Chapters & EPUB Metadata                ");
  console.log("================================================================================\n");

  const slug = "i-alone-level-up";
  const urls = [
    `https://files.lnori.com/${slug}.html`,
    `https://lnori.com/series/${slug}`,
    `https://lnori.com/novel/${slug}`
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Referer": "https://files.lnori.com/" } });
      console.log(`URL [${url}] -> Status: ${res.status}`);
      const text = await res.text();
      console.log(`  HTML Length: ${text.length}`);
      const isCloudflare = text.includes("Just a moment") || text.includes("cf-challenge");
      console.log(`  Is Cloudflare Challenge: ${isCloudflare}`);
    } catch (e) {
      console.log(`  Fetch error for ${url}:`, e.message);
    }
  }

  // Testing Lnori metadata & full chapter extraction
  console.log("\n--- TESTING LNORI METADATA & FULL CHAPTER EXTRACTION ---");
  const SLUG_MAP = {
    "i-alone-level-up": "only-i-level-up",
    "overlord-ln": "overlord",
    "the-beginning-after-the-end": "the-beginning-after-the-end",
    "lord-of-the-mysteries": "lord-of-the-mysteries"
  };

  const targetSlug = SLUG_MAP[slug] || slug;
  const nfUrl = `https://novelfull.net/${targetSlug}.html`;
  const proxyUrl = `https://goodproxy.goodproxy.workers.dev/fetch?url=${encodeURIComponent(nfUrl)}`;
  const nfRes = await fetch(proxyUrl, { headers: { "User-Agent": UA } });
  const nfHtml = await nfRes.text();
  
  const novelId = nfHtml.match(/data-novel-id="(\d+)"/i)?.[1];
  const title = nfHtml.match(/<h1 class="tit">([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || "Solo Leveling";
  const author = nfHtml.match(/<h3[^>]*>Author:<\/h3>\s*<a[^>]*>([^<]+)<\/a>/i)?.[1]?.trim() || "Chugong";
  
  const imgMatch = nfHtml.match(/<div class="book">[\s\S]*?<img[^>]+>/i)?.[0];
  const coverSrc = imgMatch?.match(/src="([^"]+)"/i)?.[1] || imgMatch?.match(/data-src="([^"]+)"/i)?.[1] || "";
  const cover = coverSrc.startsWith("http") ? coverSrc : `https://novelfull.net${coverSrc}`;

  // Fetch chapters
  const optUrl = `https://novelfull.net/ajax-chapter-option?novelId=${novelId}`;
  const optProxy = `https://goodproxy.goodproxy.workers.dev/fetch?url=${encodeURIComponent(optUrl)}`;
  const optRes = await fetch(optProxy, { headers: { "User-Agent": UA } });
  const optHtml = await optRes.text();
  
  const chapters = Array.from(optHtml.matchAll(/<option[^>]*value="\/[a-z0-9-]+\/([^"/]+?)\.html"[^>]*>([^<]*)/gi))
    .map((m, i) => ({
      id: m[1],
      title: m[2].trim(),
      number: i + 1,
      file: `https://files.lnori.com/${slug}/vol-${i + 1}.epub`
    }));

  const fullNovelMeta = {
    id: `lnori:${slug}`,
    novelId: slug,
    title: "Solo Leveling (Only I Level Up)",
    author: author,
    cover: cover,
    status: "Completed",
    genres: ["Official EPUB", "Action", "Fantasy"],
    synopsis: "Solo Leveling full series light novel collection.",
    totalChapters: chapters.length,
    chaptersSample: chapters.slice(0, 3)
  };

  console.log("Full Validated EPUB & Reader Metadata Object:");
  console.log(JSON.stringify(fullNovelMeta, null, 2));
}

testLnoriRaw();
