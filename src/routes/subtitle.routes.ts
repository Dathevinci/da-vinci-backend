import { Router, Request, Response } from 'express';
import ffmpeg from 'ffmpeg-static';
import { spawn } from 'child_process';
import axios from 'axios';

const router = Router();

/**
 * GET /api/subtitles/extract
 * Query params: videoUrl
 * Extracts the first subtitle stream (0:s:0) from the video URL, converts it to WebVTT, and streams it.
 */
router.get('/extract', (req: Request, res: Response) => {
  const { videoUrl } = req.query;
  if (!videoUrl || typeof videoUrl !== 'string') {
    return res.status(400).json({ success: false, message: 'Missing videoUrl' });
  }

  // We need to set the proper content type for WebVTT
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Spawn ffmpeg to extract the first subtitle stream
  const ffmpegArgs = [
    '-i', videoUrl,
    '-map', '0:s:0',     // Map the first subtitle stream
    '-c:s', 'webvtt',    // Convert to webvtt
    '-f', 'webvtt',      // Output format webvtt
    '-hide_banner',      // Suppress banner to keep stdout clean
    '-loglevel', 'error', // Only output errors to stderr
    'pipe:1'             // Output to stdout
  ];

  try {
    const child = spawn(ffmpeg as string, ffmpegArgs);

    // Pipe the ffmpeg stdout directly to the response
    child.stdout.pipe(res);

    child.stderr.on('data', (data) => {
      console.error(`ffmpeg stderr: ${data}`);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`ffmpeg process exited with code ${code}`);
        if (!res.headersSent) {
          res.status(500).send('WEBVTT\n\nNOTE ffmpeg extraction failed');
        } else {
          res.end();
        }
      }
    });

    // If the client closes the connection (stops watching), kill the ffmpeg process
    req.on('close', () => {
      child.kill('SIGINT');
    });

  } catch (err) {
    console.error('Failed to spawn ffmpeg:', err);
    if (!res.headersSent) {
      res.status(500).send('WEBVTT\n\nNOTE server error spawning ffmpeg');
    }
  }
});

export default router;
