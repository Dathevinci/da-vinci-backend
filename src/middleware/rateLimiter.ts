import rateLimit from "express-rate-limit";

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // per IP per window across the whole API
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
