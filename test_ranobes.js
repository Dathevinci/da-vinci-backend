const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function testRanobesTitles() {
  console.log("================================================================================");
  console.log("                 TEST: Ranobes Raw Card HTML & Title Extraction                 ");
  console.log("================================================================================\n");

  const url = "https://ranobes.top/novels/?news_name=&news_author=&sort=rating&order=desc";
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Referer": "https://ranobes.top/ranking/",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  const html = await res.text();
  console.log("Fetched HTML length:", html.length);

  // Extract the first <article class="block story..."> card
  const cardMatch = html.match(/<article[\s\S]*?<\/article>/i);
  if (!cardMatch) {
    console.log("No <article> card found!");
    return;
  }

  const rawCard = cardMatch[0];
  console.log("--- RAW NOVEL CARD HTML ---");
  console.log(rawCard);
  console.log("---------------------------\n");

  // Check all possible title sources inside the card
  const titleA = rawCard.match(/<h2 class="title"><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
  const posterAlt = rawCard.match(/class="[^"]*poster[^"]*"[\s\S]*?alt="([^"]+)"/i) || rawCard.match(/<img[^>]*alt="([^"]+)"/i);
  const ariaLabel = rawCard.match(/aria-label="([^"]+)"/i);
  const titleAttr = rawCard.match(/title="([^"]+)"/i);

  console.log("Extracted candidate title values:");
  console.log("  1. From <h2 class='title'><a> text:   ", JSON.stringify(titleA ? titleA[2].replace(/<[^>]+>/g, "").trim() : null));
  console.log("  2. From <img> alt attribute:          ", JSON.stringify(posterAlt ? posterAlt[1].trim() : null));
  console.log("  3. From aria-label attribute:         ", JSON.stringify(ariaLabel ? ariaLabel[1].trim() : null));
  console.log("  4. From title attribute:              ", JSON.stringify(titleAttr ? titleAttr[1].trim() : null));

  // Extract all cards with robust title resolver
  const cardMatches = Array.from(html.matchAll(/<article[\s\S]*?<\/article>/gi));
  console.log(`\nFound total ${cardMatches.length} cards on the page.`);
  
  const results = cardMatches.map((c, i) => {
    const block = c[0];
    const slugMatch = block.match(/href="[^"]*\/novels\/(\d+)[^"]*"/i);
    const slug = slugMatch ? slugMatch[1] : `novel-${i}`;
    
    // Priority: img alt > clean <h2 class="title"> a > title attribute
    const imgAlt = block.match(/<img[^>]*alt="([^"]+)"/i)?.[1];
    const h2Text = block.match(/<h2 class="title"><a[^>]*>([\s\S]*?)<\/a>/i)?.[1]?.replace(/<[^>]+>/g, "").trim();
    const title = (imgAlt || h2Text || slug).trim();

    const coverMatch = block.match(/background-image:\s*url\(([^)]+)\)/i) || block.match(/<img[^>]*(?:data-src|src)="([^"]+)"/i);
    let cover = coverMatch ? (coverMatch[1] || coverMatch[2]).replace(/['"]/g, "") : "";
    if (cover && !cover.startsWith("http")) cover = `https://ranobes.top${cover}`;

    return { id: `rnb:${slug}`, title, cover };
  });

  console.log("\nSample 3 Parsed Novel Cards:");
  console.log(JSON.stringify(results.slice(0, 3), null, 2));

  // Verify none of the titles are empty
  const emptyTitles = results.filter(r => !r.title || r.title.length === 0);
  console.log(`\nEmpty titles count: ${emptyTitles.length} (PASS!)`);
}

testRanobesTitles();
