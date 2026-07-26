import jwt from "jsonwebtoken";
import type { Request } from "express";

/**
 * Signed session tokens.
 *
 * In production JWT_SECRET is REQUIRED and the process refuses to boot without
 * it. The old silent fallback to a constant that lives in this repo meant that
 * if the env var were ever missing on Render, every token would be signed with a
 * publicly known value — anyone could forge a token for any account, including
 * the Lead Dev, and nothing would look wrong from the outside.
 *
 * Failing to start is the correct behaviour: a backend that is up but trivially
 * forgeable is worse than one that is visibly down.
 */
const RAW_SECRET = process.env.JWT_SECRET;

if (!RAW_SECRET && process.env.NODE_ENV === "production") {
  console.error("FATAL: JWT_SECRET is not set. Refusing to start with a known-public signing key.");
  process.exit(1);
}

const SECRET: string = RAW_SECRET || "dev-insecure-secret-change-me";
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
