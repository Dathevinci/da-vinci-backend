import rateLimit from "express-rate-limit";

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // 1500, not 300. A live duel polls its own board every 2s (30 req/min) and
  // two players on one household IP double that before anyone opens a second
  // tab — 300 per 15 minutes locked people out mid-match with "Too many
  // requests". This is a runaway-loop backstop, not access control: every
  // handler does its own auth, so a generous ceiling costs nothing.
  max: 1500,
  message: {
    success: false,
    message: "Too many requests from this IP, please try again after 15 minutes",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// The Lead Dev console is a dense, multi-panel UI that legitimately fires many
// requests per screen, so it gets its own budget rather than eating the shared
// per-IP allowance. This is a runaway-loop backstop, NOT an access control —
// requireStaff({ leadDevOnly: true }) inside every handler is the actual gate.
export const consoleLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 400,
  message: {
    success: false,
    message: "Console rate limit reached. Wait a few minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Guild chat polls its message stream every 8 seconds per open guild page —
// ~113 requests per 15 minutes before anyone types a word — so like the
// console it gets its own budget rather than eating the shared per-IP
// allowance. This is a runaway-loop backstop, NOT an access control:
// resolveActor plus the members-only gate inside every chat handler is the
// actual wall.
export const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 900,
  message: {
    success: false,
    message: "Chat rate limit reached. Wait a few minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict limiter for credential endpoints (login / signup / change-password) to
// blunt brute-force and credential-stuffing.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  message: {
    success: false,
    message: "Too many attempts. Please wait a few minutes and try again.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
