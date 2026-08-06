import { Router, Request, Response } from 'express';
import ffmpeg from 'ffmpeg-static';
import { spawn } from 'child_process';
import axios from 'axios';

const router = Router();

/**
 * GET /api/subtitles/extract
 * Query params: videoUrl
 * Extracts the first subtitle stream from the video URL, converts it to WebVTT, and streams it.
 */
router.get('/extract', (req: Request, res: Response) => {
  const { videoUrl } = req.query;
  if (!videoUrl || typeof videoUrl !== 'string') {
    return res.status(400).json({ success: false, message: 'Missing videoUrl' });
  }

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Spawn ffmpeg to extract the FIRST subtitle stream only
  const ffmpegArgs = [
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-probesize', '20000000',
    '-analyzeduration', '20000000',
    '-i', videoUrl,
    '-map', '0:s:0',              // Select ONLY the first subtitle stream (not all)
    '-c:s', 'webvtt',
    '-f', 'webvtt',
    '-hide_banner',
    '-loglevel', 'error',
    'pipe:1'
  ];

  try {
    const child = spawn(ffmpeg as string, ffmpegArgs);
    let hasData = false;

    child.stdout.on('data', () => { hasData = true; });
    child.stdout.pipe(res);

    child.stderr.on('data', (data) => {
      console.error(`ffmpeg stderr: ${data}`);
    });

    child.on('close', (code) => {
      if (code !== 0 || !hasData) {
        console.error(`ffmpeg exited with code ${code}, hasData=${hasData}`);
        if (!res.headersSent) {
          // Return a valid but empty VTT so the player doesn't error
          res.status(200).send('WEBVTT\n\n');
        } else {
          res.end();
        }
      }
    });

    // Kill ffmpeg if the client disconnects
    req.on('close', () => {
      child.kill('SIGINT');
    });

  } catch (err) {
    console.error('Failed to spawn ffmpeg:', err);
    if (!res.headersSent) {
      res.status(200).send('WEBVTT\n\n');
    }
  }
});

export default router;
