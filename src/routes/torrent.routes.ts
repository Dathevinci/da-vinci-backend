import { Router, Request, Response } from 'express';
import Parser from 'rss-parser';
import axios from 'axios';
import url from 'url';

const router = Router();
const parser = new Parser();

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

  // Sort by size or seeders if possible (RSS gives size in description)
  items.sort((a, b) => parseSize(b.contentSnippet) - parseSize(a.contentSnippet));
  const bestItem = items[0];

  return res.json({
    success: true,
    data: {
      title: bestItem.title,
      link: bestItem.link, // Magnet link
      size: bestItem.contentSnippet,
    }
  });
});

/**
 * GET /api/torrent/stream
 * Query params: magnet
 * Streams the video file from the torrent.
 */
router.get('/stream', async (req: Request, res: Response) => {
  const magnet = req.query.magnet as string;
  
  if (!magnet) {
    return res.status(400).send('Missing magnet link');
  }

  const apiKey = process.env.REAL_DEBRID_API_KEY;
  if (!apiKey) {
    return res.status(500).send('REAL_DEBRID_API_KEY is not configured on the backend.');
  }

  const headers = { Authorization: `Bearer ${apiKey}` };

  try {
    // 1. Add Magnet to Real-Debrid
    const addRes = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', 
      new URLSearchParams({ magnet }), 
      { headers }
    );
    const torrentId = addRes.data.id;

    // 2. Select all files to initiate the download/caching process
    await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, 
      new URLSearchParams({ files: 'all' }), 
      { headers }
    );

    // 3. Get Torrent Info to check if it's instantly cached
    const infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { headers });
    const info = infoRes.data;

    // If it's still downloading, tell the player it's not ready
    if (info.status !== 'downloaded') {
      return res.status(503).send('Torrent is currently being cached to Real-Debrid servers. Please try again in a few minutes.');
    }

    if (!info.links || info.links.length === 0) {
      return res.status(404).send('No valid video links found in this torrent.');
    }

    // 4. Unrestrict the link to get the direct high-speed HTTP URL
    const unrestrictRes = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link', 
      new URLSearchParams({ link: info.links[0] }), 
      { headers }
    );

    const directUrl = unrestrictRes.data.download;

    // 5. Seamlessly redirect the frontend video player to the direct stream
    return res.redirect(302, directUrl);

  } catch (error: any) {
    console.error("Real-Debrid API Error:", error.response?.data || error.message);
    return res.status(500).send('Error communicating with Real-Debrid API');
  }
});

export default router;
