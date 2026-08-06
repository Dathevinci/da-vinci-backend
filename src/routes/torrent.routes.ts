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
 * Query params: title, ep
 * Finds the best magnet link on Nyaa for the episode.
 */
router.get('/search', async (req: Request, res: Response) => {
  const { title, ep } = req.query;
  if (!title || !ep) {
    return res.status(400).json({ success: false, message: 'Missing title or ep' });
  }

  const cleanTitle = (title as string).replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const epStr = String(ep).padStart(2, '0');

  // We want to search for SubsPlease or Erai-raws preferably, as they have consistent naming.
  // First, try 4K/2160p with SubsPlease
  let items = await searchNyaa(`SubsPlease ${cleanTitle} ${epStr} 1080p`); // 4K anime is rare for weeklies, so we'll look for 1080p mostly, but we can query 2160p if requested.
  
  if (items.length === 0) {
    items = await searchNyaa(`Erai-raws ${cleanTitle} ${epStr} 1080p`);
  }
  
  if (items.length === 0) {
    items = await searchNyaa(`${cleanTitle} ${epStr} 1080p`);
  }
  
  if (items.length === 0) {
    // Fallback without resolution
    items = await searchNyaa(`${cleanTitle} ${epStr}`);
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

  // Construct a proper magnet URI from the info hash
  let magnetLink: string;
  if (bestItem.infoHash) {
    magnetLink = `magnet:?xt=urn:btih:${bestItem.infoHash}&dn=${encodeURIComponent(bestItem.title || '')}`;
  } else {
    // Fallback: try to extract from the page link
    return res.status(404).json({ success: false, message: 'No magnet link available for this torrent.' });
  }

  return res.json({
    success: true,
    data: {
      title: bestItem.title,
      link: magnetLink,
      size: bestItem.nyaaSize || bestItem.contentSnippet,
      seeders: bestItem.seeders || '0',
    }
  });
});

/**
 * GET /api/torrent/resolve
 * Query params: magnet
 * Resolves a magnet link via Real-Debrid into a direct CDN URL.
 * Returns JSON { success, url, filename, filesize, mimeType }.
 */
router.get('/resolve', async (req: Request, res: Response) => {
  const magnet = req.query.magnet as string;
  
  if (!magnet) {
    return res.status(400).json({ success: false, message: 'Missing magnet link' });
  }

  const apiKey = process.env.REAL_DEBRID_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, message: 'REAL_DEBRID_API_KEY is not configured on the backend.' });
  }

  const headers = { Authorization: `Bearer ${apiKey}` };

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
      return res.status(404).json({ success: false, message: 'No files found in this torrent.' });
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
      return res.status(404).json({ success: false, message: 'No valid video links found.' });
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
    const rdError = error.response?.data;
    const rdStatus = error.response?.status;
    console.error("Real-Debrid API Error:", rdStatus, rdError || error.message);
    return res.status(500).json({ 
      success: false, 
      message: `Real-Debrid Error (${rdStatus || 'unknown'}): ${typeof rdError === 'string' ? rdError : JSON.stringify(rdError) || error.message}` 
    });
  }
});

export default router;
