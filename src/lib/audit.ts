import crypto from "crypto";
import { prisma } from "./prisma";

/**
 * Append-only audit log for the Lead Dev console.
 *
 * Entries live in CacheItem under `audit:<iso>:<action>:<rand>`.
 *
 * TIMESTAMP FIRST, action second — this ordering is load-bearing. The key was
 * originally `audit:<action>:<iso>:...`, and since the reader sorts by key
 * descending, that sorted the feed ALPHABETICALLY BY ACTION NAME: page one of
 * "recent console activity" was whatever action sorted last, never what actually
 * just happened. On a panel whose whole purpose is spotting actions you didn't
 * take, that is worse than useless.
 *
 * The action still lives in the key (not just the JSON) because Prisma cannot
 * filter inside the `data` string — the reader filters with `contains`.
 * This is safe from the cache service, which only lazily deletes an exact key on
 * an expiry miss and never runs deleteMany.
 *
 * IMPORTANT: writeAudit NEVER THROWS and must never be moved inside a
 * $transaction. A failed audit write must not roll back a mutation that already
 * succeeded — losing the log entry is bad, silently reverting a completed grant
 * while telling the operator it worked is far worse.
 *
 * `targetLabel` is denormalized on purpose so an entry stays readable after the
 * target row is deleted.
 */
const TWO_YEARS = 1000 * 60 * 60 * 24 * 365 * 2;

export interface AuditEntry {
  actorId: string;
  actorUsername: string;
  action: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  before?: any;
  after?: any;
  note?: string;
  ip?: string;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    const key = `audit:${new Date().toISOString()}:${entry.action}:${crypto.randomBytes(6).toString("hex")}`;
    await prisma.cacheItem.create({
      data: {
        key,
        data: JSON.stringify({ ...entry, at: new Date().toISOString() }),
        expiresAt: new Date(Date.now() + TWO_YEARS),
      },
    });
  } catch (err) {
    console.error("[audit] failed to write entry:", (err as any)?.message || err);
  }
}

/** Best-effort client IP. Render sits behind a proxy; `trust proxy` is already set. */
export function actorIp(req: any): string | undefined {
  const fwd = req?.headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0]!.trim();
  return req?.ip || undefined;
}
