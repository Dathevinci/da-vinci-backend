import { Router, Request, Response } from 'express';
import axios from 'axios';

const router = Router();

/**
 * GET /api/subtitles/search
 * Query params: title, ep, lang (default: 'en')
 * Searches OpenSubtitles for matching subtitle files.
 */
router.get('/search', async (req: Request, res: Response) => {
  const { title, ep, lang } = req.query;
  if (!title || !ep) {
    return res.status(400).json({ success: false, message: 'Missing title or ep' });
  }

  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, message: 'OPENSUBTITLES_API_KEY is not configured.' });
  }

  const language = (lang as string || 'en').toLowerCase();
  const searchTitle = title as string;
  const episodeNum = parseInt(ep as string, 10);

  try {
    const response = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'Anikoto v1.0',
      },
      params: {
        query: searchTitle,
        episode_number: episodeNum,
        languages: language,
        order_by: 'download_count',
        order_direction: 'desc',
      }
    });

    const subtitles = (response.data?.data || []).map((item: any) => ({
      id: item.id,
      fileId: item.attributes?.files?.[0]?.file_id,
      language: item.attributes?.language,
      release: item.attributes?.release,
      downloadCount: item.attributes?.download_count,
      format: item.attributes?.format || 'srt',
      aiTranslated: item.attributes?.ai_translated || false,
      fps: item.attributes?.fps,
    })).filter((s: any) => s.fileId); // Only include entries with a valid file ID

    return res.json({
      success: true,
      data: subtitles,
      total: subtitles.length,
    });

  } catch (error: any) {
    console.error("OpenSubtitles search error:", error.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Error searching OpenSubtitles' });
  }
});

/**
 * GET /api/subtitles/fetch
 * Query params: fileId
 * Downloads the subtitle file from OpenSubtitles, converts SRT to WebVTT, and serves it.
 */
router.get('/fetch', async (req: Request, res: Response) => {
  const { fileId } = req.query;
  if (!fileId) {
    return res.status(400).json({ success: false, message: 'Missing fileId' });
  }

  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, message: 'OPENSUBTITLES_API_KEY is not configured.' });
  }

  try {
    // Step 1: Request the download link from OpenSubtitles
    const downloadRes = await axios.post('https://api.opensubtitles.com/api/v1/download', 
      { file_id: parseInt(fileId as string, 10) },
      {
        headers: {
          'Api-Key': apiKey,
          'Content-Type': 'application/json',
          'User-Agent': 'Anikoto v1.0',
        }
      }
    );

    const downloadLink = downloadRes.data?.link;
    if (!downloadLink) {
      return res.status(404).json({ success: false, message: 'No download link available.' });
    }

    // Step 2: Download the actual subtitle file
    const subtitleRes = await axios.get(downloadLink, { responseType: 'text' });
    let subtitleContent = subtitleRes.data as string;

    // Step 3: Convert SRT to WebVTT
    const vttContent = srtToVtt(subtitleContent);

    // Step 4: Serve as WebVTT
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(vttContent);

  } catch (error: any) {
    console.error("OpenSubtitles fetch error:", error.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Error fetching subtitle' });
  }
});

/**
 * Converts SRT subtitle format to WebVTT format.
 * SRT uses commas in timestamps (00:01:23,456) while VTT uses dots (00:01:23.456).
 */
function srtToVtt(srt: string): string {
  // Remove BOM if present
  srt = srt.replace(/^\uFEFF/, '');
  
  let vtt = 'WEBVTT\n\n';
  
  // Split into blocks
  const blocks = srt.trim().split(/\n\s*\n/);
  
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    
    // Find the timestamp line (contains -->)
    let timestampIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timestampIndex = i;
        break;
      }
    }
    
    if (timestampIndex === -1) continue;
    
    // Convert SRT timestamps (comma) to VTT timestamps (dot)
    const timestamp = lines[timestampIndex].replace(/,/g, '.');
    
    // Get the subtitle text (everything after the timestamp)
    const text = lines.slice(timestampIndex + 1).join('\n');
    
    if (text.trim()) {
      vtt += `${timestamp}\n${text}\n\n`;
    }
  }
  
  return vtt;
}

export default router;
