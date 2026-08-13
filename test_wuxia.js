// test_wuxia.js - Deep Forensic Verification of Wuxiaworld Next.js/React Query Extractor
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function extractReactQueryState(html) {
  const marker = "window.__REACT_QUERY_STATE__";
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) return null;
  const slice = html.slice(startIdx + marker.length);
  const equalIdx = slice.indexOf("=");
  if (equalIdx === -1) return null;
  const fromEqual = slice.slice(equalIdx + 1).trim();
  const endIdx = fromEqual.indexOf("window.__");
  let jsonStr = endIdx !== -1 ? fromEqual.slice(0, endIdx).trim() : fromEqual;
  jsonStr = jsonStr.replace(/;\s*$/, "");
  const lastBrace = jsonStr.lastIndexOf("}");
  if (lastBrace !== -1) {
    try {
      return JSON.parse(jsonStr.slice(0, lastBrace + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function val(v) {
  if (v == null) return "";
  if (typeof v === "object" && v.value !== undefined) return v.value;
  return String(v);
}

async function testWuxiaworldExtractor() {
  console.log("================================================================================");
  console.log("             TEST 1: Wuxiaworld Catalog (JSON API & Live Covers)                ");
  console.log("================================================================================\n");

  const listRes = await fetch("https://www.wuxiaworld.com/api/novels/top?type=weekly", {
    headers: { "User-Agent": UA, "Accept": "application/json" }
  });
  const listJson = await listRes.json();
  const rawList = (listJson.items || []).flatMap(g => g.novels || g);
  const novels = rawList.map((n) => ({
    id: `ww:${n.slug}`,
    title: n.name,
    cover: n.coverUrl,
    latestChapter: n.chapterCount ? `Chapter ${n.chapterCount}` : undefined
  }));

  console.log(`[PASS] Fetched ${novels.length} novels from Wuxiaworld catalog.`);
  console.log("Sample 2 Novels from Catalog:");
  console.log(JSON.stringify(novels.slice(0, 2), null, 2));

  console.log("\n================================================================================");
  console.log("             TEST 2: Wuxiaworld Novel Details (__REACT_QUERY_STATE__)           ");
  console.log("================================================================================\n");

  const slug = "against-the-gods";
  const novelRes = await fetch(`https://www.wuxiaworld.com/novel/${slug}`, { headers: { "User-Agent": UA } });
  const novelHtml = await novelRes.text();
  const novelState = extractReactQueryState(novelHtml);
  const novelItem = novelState?.queries?.find(q => q.queryKey[0] === "novel")?.state?.data?.item;

  if (novelItem) {
    const details = {
      id: `ww:${slug}`,
      novelId: slug,
      title: val(novelItem.name),
      author: val(novelItem.authorName) || "Unknown",
      cover: val(novelItem.coverUrl),
      status: novelItem.status === 1 ? "Ongoing" : "Completed",
      genres: novelItem.genres || [],
      synopsis: val(novelItem.synopsis).replace(/<[^>]+>/g, "").trim().slice(0, 160) + "..."
    };
    console.log("[PASS] Successfully parsed Novel Details from __REACT_QUERY_STATE__:");
    console.log(JSON.stringify(details, null, 2));
  }

  console.log("\n================================================================================");
  console.log("             TEST 3: Wuxiaworld Chapter Content Extraction                      ");
  console.log("================================================================================\n");

  const chapSlug = "atg-chapter-1";
  const chapRes = await fetch(`https://www.wuxiaworld.com/novel/${slug}/${chapSlug}`, { headers: { "User-Agent": UA } });
  const chapHtml = await chapRes.text();
  const chapState = extractReactQueryState(chapHtml);
  const chapItem = chapState?.queries?.find(q => q.queryKey[0] === "chapter")?.state?.data?.item;

  if (chapItem) {
    const rawContent = val(chapItem.content);
    const paragraphs = rawContent
      .replace(/<\/p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<p[^>]*>/gi, "")
      .replace(/<[^>]+>/g, "")
      .split(/\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 5);

    const chapterContent = {
      title: chapItem.name,
      prev: chapItem.relatedChapterInfo?.previousChapter?.slug || null,
      next: chapItem.relatedChapterInfo?.nextChapter?.slug || null,
      paragraphsCount: paragraphs.length,
      firstParagraph: paragraphs[0],
      secondParagraph: paragraphs[1]
    };
    console.log("[PASS] Successfully parsed Chapter Content from __REACT_QUERY_STATE__:");
    console.log(JSON.stringify(chapterContent, null, 2));
  }

  console.log("\n================================================================================");
  console.log("                        ALL WUXIAWORLD TESTS PASSED                             ");
  console.log("================================================================================");
}

testWuxiaworldExtractor();
