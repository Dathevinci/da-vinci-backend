import { Router, Request, Response } from 'express';
import Parser from 'rss-parser';
import axios from 'axios';
import url from 'url';

const router = Router();
const parser = new Parser({
  customFields: {
    item: [
      ['nyaa:infoHash', 'infoHash'],
      ['nyaa:seeders', 'seeders'],
      ['nyaa:size', 'nyaaSize']
    ]
  }
});

// Helper to search Nyaa.si via RSS
async function searchNyaa(query: string): Promise<any[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const feed = await parser.parseURL(`https://nyaa.si/?page=rss&q=${encodedQuery}&c=1_2&f=0`);
    return feed.items;
  } catch (error) {
    console.error(`Nyaa search error for "${query}":`, error);
    return [];
  }
}

// Helper to parse file size from Nyaa RSS description
function parseSize(description?: string): number {
  if (!description) return 0;
  // Format usually like: "1.2 GiB", "500 MiB"
  const match = description.match(/([\d\.]+)\s*([GMK]iB)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'gib') return val * 1024 * 1024 * 1024;
  if (unit === 'mib') return val * 1024 * 1024;
  if (unit === 'kib') return val * 1024;
  return val;
}

/**
 * GET /api/torrent/search
 * Query params: title, ep, quality (optional: '4k' | '1080p' | '720p')
 * Finds the best magnet link on Nyaa for the episode at the requested quality,
 * and provides fallbacks in other qualities to prevent DMCA failures.
 */
router.get('/search', async (req: Request, res: Response) => {
  const { title, ep, quality } = req.query;
  if (!title || !ep) {
    return res.status(400).json({ success: false, message: 'Missing title or ep' });
  }

  const cleanTitle = (title as string).replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const epStr = String(ep).padStart(2, '0');
  const requestedQuality = (quality as string || '1080p').toLowerCase();

  // Fansub groups to try in priority order
  const groups = ['SubsPlease', 'Erai-raws', ''];
  let allItems: any[] = [];

  for (const group of groups) {
    const query = group 
      ? `${group} ${cleanTitle} ${epStr}` 
      : `${cleanTitle} ${epStr}`;
    const items = await searchNyaa(query);
    if (items.length > 0) {
      allItems = items;
      break; // Found items with this group, no need to fallback to less specific queries
    }
  }

  if (allItems.length === 0) {
    return res.status(404).json({ success: false, message: 'No torrents found.' });
  }

  // Helper to score how closely an item matches the requested resolution
  function getResScore(title: string, reqQual: string): number {
    const t = title.toLowerCase();
    const has4k = t.includes('2160p') || t.includes('4k');
    const has1080 = t.includes('1080p');
    const has720 = t.includes('720p');
    const has480 = t.includes('480p');
    
    if (reqQual === '4k' || reqQual === '2160p') {
      if (has4k) return 4;
      if (has1080) return 3;
      if (has720) return 2;
      return 1;
    } else if (reqQual === '720p') {
      if (has720) return 4;
      if (has1080) return 3;
      if (has480) return 2;
      if (has4k) return 1;
      return 0;
    } else {
      // Default to 1080p preference
      if (has1080) return 4;
      if (has720) return 3;
      if (has4k) return 2; // Usually we prefer 720p over 4k if 1080p is missing, to save bandwidth
      return 1;
    }
  }

  // Sort by resolution score first, then seeders, then size
  allItems.sort((a, b) => {
    const scoreA = getResScore(a.title, requestedQuality);
    const scoreB = getResScore(b.title, requestedQuality);
    if (scoreA !== scoreB) return scoreB - scoreA;
    
    const seedA = parseInt(a.seeders) || 0;
    const seedB = parseInt(b.seeders) || 0;
    if (seedB !== seedA) return seedB - seedA;
    
    return parseSize(b.contentSnippet) - parseSize(a.contentSnippet);
  });

  // Take top 15 results to provide plenty of fallbacks to Real-Debrid
  const topItems = allItems.slice(0, 15);
  const bestItem = topItems[0];

  // Determine the actual matched quality of the best item
  let matchedQuality = 'auto';
  const bestTitle = bestItem.title.toLowerCase();
  if (bestTitle.includes('2160p') || bestTitle.includes('4k')) matchedQuality = '2160p';
  else if (bestTitle.includes('1080p')) matchedQuality = '1080p';
  else if (bestTitle.includes('720p')) matchedQuality = '720p';
  else if (bestTitle.includes('480p')) matchedQuality = '480p';

  // Construct proper magnet URIs for all found items
  const allMagnets: string[] = topItems
    .filter((item: any) => item.infoHash)
    .map((item: any) => `magnet:?xt=urn:btih:${item.infoHash}&dn=${encodeURIComponent(item.title || '')}`);

  if (allMagnets.length === 0) {
    return res.status(404).json({ success: false, message: 'No magnet link available for this torrent.' });
  }

  const magnetLink = allMagnets[0];

  return res.json({
    success: true,
    data: {
      title: bestItem.title,
      link: magnetLink,
      allMagnets,
      size: bestItem.nyaaSize || bestItem.contentSnippet,
      seeders: bestItem.seeders || '0',
      quality: matchedQuality,
    }
  });
});

/**
 * GET /api/torrent/resolve
 * Query params: magnet OR magnets (JSON array of candidate magnet links)
 * Resolves a magnet link via Real-Debrid into a direct CDN URL.
 * Automatically cascades to alternative candidates if a magnet is DMCA blacklisted (infringing_file).
 */
router.get('/resolve', async (req: Request, res: Response) => {
  let magnetList: string[] = [];
  if (req.query.magnets) {
    try {
      magnetList = JSON.parse(req.query.magnets as string);
    } catch {
      magnetList = [req.query.magnets as string];
    }
  } else if (req.query.magnet) {
    magnetList = [req.query.magnet as string];
  }
  
  if (magnetList.length === 0) {
    return res.status(400).json({ success: false, message: 'Missing magnet link(s)' });
  }

  const apiKey = process.env.REAL_DEBRID_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, message: 'REAL_DEBRID_API_KEY is not configured on the backend.' });
  }

  const headers = { Authorization: `Bearer ${apiKey}` };

  // Check instantAvailability to prioritize torrents that are already 100% cached on Real-Debrid
  const hashToMagnet = new Map<string, string>();
  const hashes: string[] = [];
  for (const m of magnetList) {
    const match = m.match(/btih:([a-fA-F0-9]{40})/i) || m.match(/btih:([a-zA-Z0-9]{32})/i);
    if (match) {
      const h = match[1].toLowerCase();
      hashes.push(h);
      hashToMagnet.set(h, m);
    }
  }

  if (hashes.length > 0) {
    try {
      const hashPath = hashes.join('/');
      const checkRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hashPath}`, { headers });
      const checkData = checkRes.data || {};
      
      const instantMagnets: string[] = [];
      const nonInstantMagnets: string[] = [];
      for (const h of hashes) {
        const itemData = checkData[h];
        if (itemData && itemData.rd && Array.isArray(itemData.rd) && itemData.rd.length > 0) {
          instantMagnets.push(hashToMagnet.get(h)!);
        } else {
          nonInstantMagnets.push(hashToMagnet.get(h)!);
        }
      }

      if (instantMagnets.length > 0) {
        magnetList = [...instantMagnets, ...nonInstantMagnets];
      }
    } catch (e) {
      console.warn("Real-Debrid instantAvailability check skipped:", e);
    }
  }

  let lastError: any = null;

  for (let i = 0; i < magnetList.length; i++) {
    const magnet = magnetList[i];
    try {
      // 1. Add Magnet to Real-Debrid
      const addRes = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', 
        new URLSearchParams({ magnet }), 
        { headers }
      );
      const torrentId = addRes.data.id;

      // 2. Get Torrent Info to see available files
      let infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { headers });
      let info = infoRes.data;

      // 3. Find the largest file (the main video)
      if (!info.files || info.files.length === 0) {
        continue;
      }
      const largestFile = info.files.reduce((prev: any, current: any) => (prev.bytes > current.bytes) ? prev : current);

      // 4. Select ONLY the largest file
      await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, 
        new URLSearchParams({ files: largestFile.id.toString() }), 
        { headers }
      );

      // 5. Poll up to 5 times (7.5s max) if status is not 'downloaded' yet
      let attempts = 0;
      while (info.status !== 'downloaded' && attempts < 5) {
        await new Promise(r => setTimeout(r, 1500));
        infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { headers });
        info = infoRes.data;
        attempts++;
      }

      if (info.status !== 'downloaded') {
        // If not downloaded yet and we have other magnet candidates, try the next candidate!
        if (i < magnetList.length - 1) {
          continue;
        }
        return res.status(202).json({ 
          success: false, 
          message: 'Torrent is being cached on Real-Debrid. Please retry in a moment.',
          status: info.status,
          progress: info.progress 
        });
      }

      if (!info.links || info.links.length === 0) {
        continue;
      }

      // 6. Unrestrict the link to get the direct CDN URL
      const unrestrictRes = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link', 
        new URLSearchParams({ link: info.links[0] }), 
        { headers }
      );

      const data = unrestrictRes.data;

      return res.json({
        success: true,
        url: data.download,
        filename: data.filename,
        filesize: data.filesize,
        mimeType: data.mimeType,
      });

    } catch (error: any) {
      lastError = error;
      const rdError = error.response?.data;
      const rdStatus = error.response?.status;
      const isInfringing = rdStatus === 451 || rdError?.error === 'infringing_file' || rdError?.error_code === 35;

      if (isInfringing && i < magnetList.length - 1) {
        console.warn(`Magnet ${i + 1}/${magnetList.length} is DMCA blacklisted. Auto-trying next magnet...`);
        continue;
      }
      
      break;
    }
  }

  const rdError = lastError?.response?.data;
  const rdStatus = lastError?.response?.status;
  console.error("Real-Debrid API Error:", rdStatus, rdError || lastError?.message);
  return res.status(500).json({ 
    success: false, 
    message: `Real-Debrid Error (${rdStatus || 'unknown'}): ${typeof rdError === 'string' ? rdError : JSON.stringify(rdError) || lastError?.message}` 
  });
});

export default router;
