import { Router, Request, Response } from 'express';
import Parser from 'rss-parser';
import torrentStream from 'torrent-stream';
import url from 'url';

const router = Router();
const parser = new Parser();

// Active torrent engines map to prevent re-downloading/spinning up multiple engines for the same magnet
const engines = new Map<string, any>();

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
router.get('/stream', (req: Request, res: Response) => {
  const magnet = req.query.magnet as string;
  
  if (!magnet) {
    return res.status(400).send('Missing magnet link');
  }

  const engine = engines.get(magnet) || torrentStream(magnet, {
    connections: 100,
    uploads: 10,
    tmp: './tmp', // store temporary chunks
    trackers: [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://tracker.openbittorrent.com:80/announce',
      'udp://tracker.coppersurfer.tk:6969/announce',
      'udp://tracker.leechers-paradise.org:6969/announce',
      'udp://p4p.arenabg.com:1337/announce',
      'udp://tracker.internetwarriors.net:1337/announce'
    ]
  });

  if (!engines.has(magnet)) {
    engines.set(magnet, engine);
    
    // Optional: cleanup after 1 hour if idle
    setTimeout(() => {
      if (engines.has(magnet)) {
        engine.destroy(() => {
          engines.delete(magnet);
        });
      }
    }, 60 * 60 * 1000);
  }

  engine.on('ready', () => {
    // Find the largest file (assume it's the video)
    const file = engine.files.reduce((a: any, b: any) => (a.length > b.length ? a : b));
    
    file.select();

    const range = req.headers.range;
    if (!range) {
      const head = {
        'Content-Length': file.length,
        'Content-Type': 'video/webm', // WebM triggers Chromium's internal Matroska demuxer, enabling MKV playback
      };
      res.writeHead(200, head);
      file.createReadStream().pipe(res);
      return;
    }

    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
    const chunksize = (end - start) + 1;

    const head = {
      'Content-Range': `bytes ${start}-${end}/${file.length}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/webm',
    };

    res.writeHead(206, head);
    const stream = file.createReadStream({ start, end });
    stream.pipe(res);
  });
});

export default router;
