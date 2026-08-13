// test_scraper.ts - Comprehensive reverse-engineering test for Manganato & Mangasee
import axios from "axios";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PROXY = "https://goodproxy.goodproxy.workers.dev/fetch?url=";

// ── 1. Mangasee 6-Digit Decoder & URL Generator ─────────────────────────────
export function decodeMangaseeChapter(raw: string | number): { chapterNum: string; displayTitle: string; slug: string } {
  const s = String(raw).trim();
  if (/^\d{6}$/.test(s)) {
    const mainNum = parseInt(s.slice(1, 5), 10);
    const dec = s.slice(5);
    const chapterNum = dec === "0" ? String(mainNum) : `${mainNum}.${dec}`;
    return {
      chapterNum,
      displayTitle: `Chapter ${chapterNum}`,
      slug: chapterNum
    };
  }
  const numMatch = s.match(/([0-9.]+)/);
  const chapterNum = numMatch ? numMatch[1] : "1";
  return {
    chapterNum,
    displayTitle: `Chapter ${chapterNum}`,
    slug: chapterNum
  };
}

export function buildMangaseeReadUrl(indexName: string, chapterNum: string): string {
  return `https://mangasee123.com/read-online/${indexName}-chapter-${chapterNum}.html`;
}

// ── Test Runners ────────────────────────────────────────────────────────────

async function fetchHtmlWithFallback(url: string, referer = "https://www.manganato.gg/"): Promise<string> {
  try {
    const res: any = await axios.get(url, {
      headers: { "User-Agent": UA, Referer: referer },
      timeout: 6000
    });
    return String(res.data || "");
  } catch {}

  const pRes: any = await axios.get(PROXY + encodeURIComponent(url), {
    headers: { "User-Agent": UA },
    timeout: 8000
  });
  return String(pRes.data || "");
}

async function testManganatoDirect() {
  console.log("================================================================================");
  console.log("           PHASE 1.1: INVESTIGATING MANGANATO 'SERIES NOT FOUND'                ");
  console.log("================================================================================");

  const testSlugs = [
    "logging-10000-years-into-the-future-apex-future-martial-arts",
    "solo-leveling",
    "manga-bn978870"
  ];

  for (const slug of testSlugs) {
    const urls = [
      `https://www.manganato.gg/manga/${slug}`,
      `https://chapmanganato.to/${slug}`,
      `https://manganato.com/${slug}`
    ];

    for (const url of urls) {
      console.log(`\nProbing Manganato endpoint: ${url}`);
      try {
        const html = await fetchHtmlWithFallback(url);
        console.log(`  -> HTML Length: ${html.length} bytes`);
        
        const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : "N/A";
        console.log(`  -> Extracted Title: "${title}"`);

        // Check for chapter list in raw HTML
        const chaps = Array.from(html.matchAll(/href="([^"]*(?:chapter-[0-9.]+|chapter\/[0-9.]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi));
        console.log(`  -> Found ${chaps.length} chapter link matches in raw HTML`);
        if (chaps.length > 0) {
          console.log(`     Sample Chapter 1: Href: ${chaps[0][1]} | Text: "${chaps[0][2].replace(/<[^>]+>/g, '').trim()}"`);
          break; // successfully found
        }
      } catch (err: any) {
        console.log(`  -> Failed with error: ${err.message}`);
      }
    }
  }
}

async function testHotlinkProtection() {
  console.log("\n================================================================================");
  console.log("           PHASE 1.2: PROBING IMAGE HOTLINK PROTECTION (403 CHECK)              ");
  console.log("================================================================================");

  const testCovers = [
    "https://img-r2.2xstorage.com/thumb/logging-10000-years-into-the-future-apex-future-martial-arts.webp",
    "https://temp.compsci88.com/cover/Solo-Leveling.jpg",
    "https://official.mangasee123.com/cover/Solo-Leveling.jpg"
  ];

  for (const cover of testCovers) {
    console.log(`\nTesting Cover URL: ${cover}`);
    // 1. Without Referer
    try {
      const bareRes: any = await axios.get(cover, {
        headers: { "User-Agent": UA },
        timeout: 5000,
        validateStatus: () => true
      });
      console.log(`  Direct request without Referer => HTTP Status: ${bareRes.status}`);
    } catch (e: any) {
      console.log(`  Direct request without Referer => Threw: ${e.message}`);
    }

    // 2. With appropriate Referer (Backend Proxy Simulation)
    try {
      const referer = cover.includes("2xstorage") ? "https://www.manganato.gg/" : "https://weebcentral.com/";
      const proxiedRes: any = await axios.get(cover, {
        headers: { "User-Agent": UA, Referer: referer },
        responseType: "arraybuffer",
        timeout: 5000,
        validateStatus: () => true
      });
      console.log(`  Backend Proxy Request with Referer ("${referer}") => HTTP Status: ${proxiedRes.status}, Content-Type: ${proxiedRes.headers["content-type"]}, Bytes: ${proxiedRes.data?.length}`);
    } catch (e: any) {
      console.log(`  Backend Proxy Request with Referer => Threw: ${e.message}`);
    }
  }
}

async function testMangaseeEmbeddedScript() {
  console.log("\n================================================================================");
  console.log("           PHASE 1.3: MANGASEE EMBEDDED JSON & DECODER REVERSE ENGINEERING     ");
  console.log("================================================================================");

  const msUrls = [
    "https://mangasee123.com/manga/Solo-Leveling",
    "https://weebcentral.com/series/01J76XYCPSY3C4BNPBRY8JMCBE/full-chapter-list"
  ];

  for (const url of msUrls) {
    console.log(`\nFetching Mangasee URL: ${url}`);
    try {
      const html = await fetchHtmlWithFallback(url, "https://mangasee123.com/");
      console.log(`  -> HTML Length: ${html.length} bytes`);

      // Search for vm.Chapters or embedded JSON scripts
      const vmChaptersMatch = html.match(/vm\.Chapters\s*=\s*(\[[^;]+\]);/);
      const vmDirectoryMatch = html.match(/vm\.Directory\s*=\s*(\[[^;]+\]);/);

      if (vmChaptersMatch) {
        console.log("  [FOUND] `vm.Chapters` JSON block in raw HTML!");
        const rawJson = JSON.parse(vmChaptersMatch[1]);
        console.log(`  -> Total parsed chapters: ${rawJson.length}`);
        console.log(`  -> First 3 raw entries:`, JSON.stringify(rawJson.slice(0, 3), null, 2));

        const decodedList = rawJson.slice(0, 3).map((item: any) => {
          const dec = decodeMangaseeChapter(item.Chapter);
          return {
            rawChapter: item.Chapter,
            decodedChapterNum: dec.chapterNum,
            displayTitle: dec.displayTitle,
            readUrl: buildMangaseeReadUrl("Solo-Leveling", dec.slug),
            date: item.Date
          };
        });
        console.log(`  -> Decoded Clean Chapters:`, JSON.stringify(decodedList, null, 2));
      } else {
        console.log("  [INFO] Probing WeebCentral chapter list...");
        const chapMatches = Array.from(html.matchAll(/href="(?:https:\/\/weebcentral\.com)?\/chapters\/([^"]+)"[\s\S]*?<span[^>]*>(Chapter\s+[^<]+)<\/span>/gi));
        console.log(`  -> Found ${chapMatches.length} parsed chapter links on WeebCentral!`);
        if (chapMatches.length > 0) {
          const sampleDecoded = decodeMangaseeChapter(chapMatches[0][2]);
          console.log(`  -> Sample Decoded Chapter: ${sampleDecoded.displayTitle} => https://weebcentral.com/chapters/${chapMatches[0][1]}`);
        }
      }
    } catch (err: any) {
      console.log(`  -> Failed with error: ${err.message}`);
    }
  }
}

async function main() {
  await testManganatoDirect();
  await testHotlinkProtection();
  await testMangaseeEmbeddedScript();
  console.log("\n================================================================================");
  console.log("                 PHASE 1 FORENSIC REVERSE ENGINEERING COMPLETE                  ");
  console.log("================================================================================\n");
}

main().catch(console.error);
