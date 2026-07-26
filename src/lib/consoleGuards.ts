import { prisma } from "./prisma";
import type { Actor } from "./staff";

/**
 * Guardrails shared by every Lead Dev console mutation.
 *
 * The console can delete accounts, mint currency and take the site down, and
 * there is no `prisma migrate` and no DB console in this workflow — so a few
 * mistakes would be genuinely unrecoverable. Those are hard walls here, not
 * confirmation dialogs.
 */

/** Only these three values may ever be written to User.role. */
export const ALLOWED_ROLES = ["USER", "ADMIN", "LEAD_DEV"] as const;
export type AllowedRole = (typeof ALLOWED_ROLES)[number];

export function isAllowedRole(v: any): v is AllowedRole {
  return typeof v === "string" && (ALLOWED_ROLES as readonly string[]).includes(v);
}

/**
 * Counting LEAD_DEVs by the `role` column alone is not safe: an account can be
 * lead dev via getRole(username) while its column is still an unbackfilled
 * "USER", so a plain count can return 0 while a working owner exists. The OR
 * keeps the count honest.
 */
export async function leadDevCount(): Promise<number> {
  return prisma.user.count({
    where: {
      OR: [{ role: "LEAD_DEV" }, { username: { equals: "dejavuh", mode: "insensitive" } }],
    },
  });
}

/** Per-call AP ceiling. The priciest shop item is 25,500, so one stray zero on a
 *  5,000 grant would hand out two of them. */
export const MAX_AP_PER_CALL = 100_000;
/** Rolling per-actor ceiling, in-process (resets on dyno restart — a brake, not a vault). */
export const MAX_AP_PER_HOUR = 250_000;

const apWindow = new Map<string, { total: number; resetAt: number }>();

export function checkApBrake(actorId: string, amount: number): { ok: boolean; message?: string } {
  const now = Date.now();
  const cur = apWindow.get(actorId);
  if (!cur || now > cur.resetAt) {
    apWindow.set(actorId, { total: Math.abs(amount), resetAt: now + 60 * 60 * 1000 });
    return { ok: true };
  }
  if (cur.total + Math.abs(amount) > MAX_AP_PER_HOUR) {
    return {
      ok: false,
      message: `Hourly Arise Point limit reached (${MAX_AP_PER_HOUR.toLocaleString()}). Wait for the window to reset.`,
    };
  }
  cur.total += Math.abs(amount);
  return { ok: true };
}

/** Integer, non-zero, within the per-call ceiling. */
export function validateAmount(raw: any): { ok: true; amount: number } | { ok: false; message: string } {
  const amount = Number(raw);
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    return { ok: false, message: "Amount must be a whole number." };
  }
  if (amount === 0) return { ok: false, message: "Amount can't be zero." };
  if (Math.abs(amount) > MAX_AP_PER_CALL) {
    return { ok: false, message: `Amount can't exceed ${MAX_AP_PER_CALL.toLocaleString()} in a single action.` };
  }
  return { ok: true, amount };
}

/** Blocks acting on yourself for the operations that could lock you out. */
export function assertNotSelf(actor: Actor, targetId: string, what: string): string | null {
  if (actor.id === targetId) {
    return `You can't ${what} your own account from the console.`;
  }
  return null;
}

/** Pagination that can't be used to pull the whole table in one request. */
export function parsePage(req: any): { page: number; perPage: number; skip: number } {
  const page = Math.max(1, Number(req.query?.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query?.perPage) || 25));
  return { page, perPage, skip: (page - 1) * perPage };
}

/**
 * Type-to-confirm, re-verified on the server so a direct curl gets exactly the
 * same friction as the modal. A client-only confirmation is decoration.
 */
export function confirmMatches(provided: any, expected: string): boolean {
  return typeof provided === "string" && provided.trim().toLowerCase() === expected.trim().toLowerCase();
}
