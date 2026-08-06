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
 * Finds the best magnet link on Nyaa for the episode at the requested quality.
 */
router.get('/search', async (req: Request, res: Response) => {
  const { title, ep, quality } = req.query;
  if (!title || !ep) {
    return res.status(400).json({ success: false, message: 'Missing title or ep' });
  }

  const cleanTitle = (title as string).replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const epStr = String(ep).padStart(2, '0');
  const requestedQuality = (quality as string || '1080p').toLowerCase();

  // Build resolution cascade based on requested quality
  const resolutions: string[] = [];
  if (requestedQuality === '4k' || requestedQuality === '2160p') {
    resolutions.push('2160p', '1080p', '720p');
  } else if (requestedQuality === '720p') {
    resolutions.push('720p', '480p');
  } else {
    // Default: 1080p
    resolutions.push('1080p', '720p');
  }

  // Fansub groups to try in priority order
  const groups = ['SubsPlease', 'Erai-raws', ''];
  
  let items: any[] = [];
  let matchedQuality = '';

  // Try each resolution tier, and for each tier try preferred groups first
  for (const res of resolutions) {
    for (const group of groups) {
      const query = group 
        ? `${group} ${cleanTitle} ${epStr} ${res}` 
        : `${cleanTitle} ${epStr} ${res}`;
      items = await searchNyaa(query);
      if (items.length > 0) {
        matchedQuality = res;
        break;
      }
    }
    if (items.length > 0) break;
  }

  // Final fallback: search without any resolution filter
  if (items.length === 0) {
    for (const group of groups) {
      const query = group 
        ? `${group} ${cleanTitle} ${epStr}` 
        : `${cleanTitle} ${epStr}`;
      items = await searchNyaa(query);
      if (items.length > 0) {
        matchedQuality = 'auto';
        break;
      }
    }
  }

  if (items.length === 0) {
    return res.status(404).json({ success: false, message: 'No torrents found.' });
  }

  // Sort by seeders first (more seeders = faster), then by size as tiebreaker
  items.sort((a, b) => {
    const seedA = parseInt(a.seeders) || 0;
    const seedB = parseInt(b.seeders) || 0;
    if (seedB !== seedA) return seedB - seedA;
    return parseSize(b.contentSnippet) - parseSize(a.contentSnippet);
  });
  const bestItem = items[0];

  // Construct proper magnet URIs for all found items
  const allMagnets: string[] = items
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

      // 5. Re-fetch info to check cache status
      infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { headers });
      info = infoRes.data;

      if (info.status !== 'downloaded') {
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
        console.warn(`Magnet ${i + 1}/${magnetList.length} is DMCA blacklisted (infringing_file). Auto-trying next magnet...`);
        continue;
      }
      
      // If not an infringing file or no more candidates, break and return error
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
