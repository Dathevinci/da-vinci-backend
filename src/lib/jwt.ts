import jwt from "jsonwebtoken";
import type { Request } from "express";

// Signed session tokens. Set JWT_SECRET in the Render env — without it, tokens
// fall back to an insecure dev secret (fine for local, NOT for production).
const SECRET: string = process.env.JWT_SECRET || "dev-insecure-secret-change-me";
const EXPIRES_IN_SECONDS = 60 * 24 * 60 * 60; // 60 days (numeric avoids @types StringValue pitfalls)

export function signToken(userId: string): string {
  return jwt.sign({ userId }, SECRET, { expiresIn: EXPIRES_IN_SECONDS });
}

export function verifyToken(token: string): { userId: string } | null {
  try {
    const decoded = jwt.verify(token, SECRET) as any;
    return decoded && typeof decoded.userId === "string" ? { userId: decoded.userId } : null;
  } catch {
    return null;
  }
}

/**
 * Read + verify a JWT from the `Authorization: Bearer <token>` header and return
 * the actor's userId, or null if it's absent/invalid.
 *
 * null means "no proven identity" — a grandfathered pre-JWT session. Callers
 * decide what to do with that: soft endpoints allow it (back-compat), hard
 * endpoints (account deletion) reject it.
 *
 * NOTE: this is intentionally SEPARATE from invite.routes.ts, which uses a
 * legacy `Bearer <rawUserId>` scheme. Only routes that opt into getActorId()
 * treat the Bearer value as a JWT.
 */
export function getActorId(req: Request): string | null {
  const h = req.headers?.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  const token = h.slice(7).trim();
  if (!token) return null;
  return verifyToken(token)?.userId ?? null;
}
