import { Request, Response } from "express";
import axios from "axios";

const ALLOWED_IMAGE_HOSTS = [
  "manganato.com",
  "manganato.gg",
  "chapmanganato.to",
  "2xstorage.com",
  "waitst.com",
  "compsci88.com",
  "planeptune.us",
  "mangasee123.com",
  "lowee.us",
  "leanbox.us",
  "epicstream.com",
  "vortexscans.org",
  "asuracomic.net",
  "asurascans.com",
];

function isHostAllowed(hostname: string): boolean {
  return ALLOWED_IMAGE_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

function getRefererForHost(hostname: string): string {
  if (hostname.includes("manganato") || hostname.includes("2xstorage") || hostname.includes("waitst")) {
    return "https://www.manganato.gg/";
  }
  if (hostname.includes("compsci88") || hostname.includes("planeptune") || hostname.includes("mangasee") || hostname.includes("lowee") || hostname.includes("leanbox")) {
    return "https://weebcentral.com/";
  }
  if (hostname.includes("vortexscans")) {
    return "https://vortexscans.org/";
  }
  return "https://asuracomic.net/";
}

export async function proxyImageHandler(req: Request, res: Response): Promise<void> {
  const targetUrl = req.query.url as string;
  if (!targetUrl) {
    res.status(400).send("Missing image url query parameter");
    return;
  }

  try {
    const parsed = new URL(targetUrl);
    if (!isHostAllowed(parsed.hostname)) {
      res.status(403).send("Host not allowed");
      return;
    }

    const referer = getRefererForHost(parsed.hostname);
    const response = await axios.get(targetUrl, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Referer: referer,
      },
      timeout: 10000,
    });

    const contentType = String(response.headers["content-type"] || "image/jpeg");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400");

    res.send(Buffer.from(response.data));
  } catch (error: any) {
    res.status(500).send(`Image proxy error: ${error.message}`);
  }
}
