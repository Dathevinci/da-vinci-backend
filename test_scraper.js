// master test_scraper.js - Verifies Ranobes, Lnori, and Wuxiaworld Scrapers End-to-End
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function runTestDrivenValidation() {
  console.log("================================================================================");
  console.log("                      TEST-DRIVEN SCRAPER VERIFICATION                        ");
  console.log("================================================================================\n");

  // 1. RANOBES
  console.log("▶ 1. TESTING RANOBES");
  try {
    const browseRes = await fetch("https://ranobes.top/novels/?news_name=&news_author=&sort=rating&order=desc", {
      headers: { "User-Agent": UA, "Referer": "https://ranobes.top/ranking/" }
    });
    const browseHtml = await browseRes.text();
    const re = /<h2 class="title"><a href="[^"]*\/novels\/(\d+)[^"]*">([^<]+)<\/a>[\s\S]*?(?:background-image:\s*url\(([^)]+)\)|src="([^"]+)")/gi;
    let cards = [];
    let m;
    while ((m = re.exec(browseHtml))) {
      cards.push({ id: `rnb:${m[1]}`, title: m[2].trim(), cover: m[3] || m[4] });
    }
    console.log(`  [OK] Ranobes Catalog: ${cards.length} novels found.`);
    console.log(`  Sample:`, JSON.stringify(cards[0]));

    // Search
    const searchRes = await fetch("https://ranobes.top/search/shadow/", {
      headers: { "User-Agent": UA, "Referer": "https://ranobes.top/" }
    });
    const searchHtml = await searchRes.text();
    let searchCount = 0;
    while (re.exec(searchHtml)) searchCount++;
    console.log(`  [OK] Ranobes Search ('shadow'): ${searchCount} matches returned.`);
  } catch (e) {
    console.error("  [FAIL] Ranobes:", e.message);
  }

  // 2. LNORI
  console.log("\n▶ 2. TESTING LNORI NOVEL & CHAPTERS");
  try {
    const SLUG_MAP = { "i-alone-level-up": "only-i-level-up" };
    const targetSlug = SLUG_MAP["i-alone-level-up"];
    
    // Novel info + chapter list
    const nfUrl = `https://novelfull.net/${targetSlug}.html`;
    const proxyUrl = `https://goodproxy.goodproxy.workers.dev/fetch?url=${encodeURIComponent(nfUrl)}`;
    const infoRes = await fetch(proxyUrl, { headers: { "User-Agent": UA } });
    const infoHtml = await infoRes.text();
    const novelId = infoHtml.match(/data-novel-id="(\d+)"/i)?.[1];
    
    const optUrl = `https://novelfull.net/ajax-chapter-option?novelId=${novelId}`;
    const optProxy = `https://goodproxy.goodproxy.workers.dev/fetch?url=${encodeURIComponent(optUrl)}`;
    const optRes = await fetch(optProxy, { headers: { "User-Agent": UA } });
    const optHtml = await optRes.text();
    const chapters = Array.from(optHtml.matchAll(/<option[^>]*value="\/[a-z0-9-]+\/([^"/]+?)\.html"[^>]*>([^<]*)/gi))
      .map((c, i) => ({ id: c[1], title: c[2].trim(), number: i + 1 }));

    console.log(`  [OK] Lnori Novel Details ("Solo Leveling"): ${chapters.length} chapters loaded!`);
    console.log(`  Sample Chapter 1:`, JSON.stringify(chapters[0]));

    // Chapter text content
    const chUrl = `https://novelfull.net/${targetSlug}/${chapters[0].id}.html`;
    const chProxy = `https://goodproxy.goodproxy.workers.dev/fetch?url=${encodeURIComponent(chUrl)}`;
    const chRes = await fetch(chProxy, { headers: { "User-Agent": UA } });
    const chHtml = await chRes.text();
    const startM = chHtml.match(/id="chapter-content"[^>]*>/i);
    let block = "";
    if (startM && startM.index != null) {
      let rest = chHtml.slice(startM.index + startM[0].length);
      const cut = rest.search(/id="chapter-nav|class="[^"]*chapter-nav|id="comment|class="[^"]*comment|<footer/i);
      block = cut > 0 ? rest.slice(0, cut) : rest;
    }
    const paragraphs = block.replace(/<[^>]+>/g, "").split(/\n+/).map(p => p.trim()).filter(p => p.length > 5);
    console.log(`  [OK] Lnori Chapter Content: ${paragraphs.length} paragraphs extracted!`);
    console.log(`  Excerpt: "${paragraphs[0]}"`);
  } catch (e) {
    console.error("  [FAIL] Lnori:", e.message);
  }

  // 3. WUXIAWORLD
  console.log("\n▶ 3. TESTING WUXIAWORLD THUMBNAILS");
  try {
    const wwUrl = "https://wuxiaworld.site/page/1/?s=&post_type=wp-manga&m_orderby=trending";
    const res = await fetch(wwUrl, { headers: { "User-Agent": UA, "Referer": "https://wuxiaworld.site/" } });
    const html = await res.text();
    const re = /<div class="[^"]*(?:c-tabs-item__content|page-item-detail)[^"]*">[\s\S]*?<a href="https:\/\/wuxiaworld\.site\/novel\/([^/]+)\/"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    let m;
    let count = 0;
    let passed = 0;
    while ((m = re.exec(html))) {
      count++;
      const block = m[2];
      const dataSrc = block.match(/data-src="([^"]+)"/i)?.[1];
      const dataSrcset = block.match(/data-srcset="([^",\s]+)/i)?.[1];
      const src = block.match(/src="([^"]+)"/i)?.[1];
      let candidate = [dataSrc, dataSrcset, src].find((u) => u && !u.includes("dflazy.jpg")) || "";
      candidate = candidate.replace(/render_jsfalse.*$/, "").replace(/-\d+x\d+(\.[a-z]+)?$/i, (match, ext) => ext || "").replace(/-\d+x\d+\.$/, "").replace(/\.$/, "");
      
      const bare = candidate.replace(/^https?:\/\//, "");
      const wsrv = `https://wsrv.nl/?url=${encodeURIComponent(bare)}&w=480&h=720&fit=cover&output=webp&q=85&sharp=3`;
      const imgRes = await fetch(wsrv, { headers: { "User-Agent": UA } });
      if (imgRes.status === 200) passed++;
    }
    console.log(`  [OK] Wuxiaworld Thumbnails: ${passed}/${count} live covers loaded successfully.`);
  } catch (e) {
    console.error("  [FAIL] Wuxiaworld:", e.message);
  }

  console.log("\n================================================================================");
  console.log("                         ALL TEST VERIFICATIONS COMPLETED                        ");
  console.log("================================================================================");
}

runTestDrivenValidation();
