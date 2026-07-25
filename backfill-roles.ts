import { PrismaClient } from "@prisma/client";

/**
 * Backfill the persistent `role` column for staff accounts.
 *
 * Roles must NOT be keyed off usernames: a username is mutable, so an admin who
 * renames would silently lose staff powers (and whoever took the old name would
 * inherit them). `getRole(username)` exists only as a self-heal fallback for
 * accounts whose `role` was never written — this script writes it for real, so
 * the column stays authoritative.
 *
 * Self-contained ON PURPOSE: root scripts run under ts-node WITHOUT @types/node,
 * so importing anything from src/ that touches `process.env` fails the build
 * with TS2591. The lists below therefore mirror src/utils/economy.ts — keep the
 * two in sync (and the frontend's src/lib/admin.ts).
 *
 * Safe to run on every deploy: it only writes rows whose role doesn't already
 * match, so once backfilled it's a no-op. Never throws — a role hiccup must not
 * fail the whole build.
 */

const prisma = new PrismaClient();

const LEAD_DEV = ["dejavuh"];
const ADMINS = ["davinci", "xhackerdevil", "coffee", "speyvenerable", "ash"];

async function apply(usernames: string[], role: "LEAD_DEV" | "ADMIN") {
  let changed = 0;
  for (const name of usernames) {
    try {
      // Case-insensitive: the accounts were created with varying capitalisation.
      const user = await prisma.user.findFirst({
        where: { username: { equals: name, mode: "insensitive" } },
        select: { id: true, username: true, role: true },
      });
      if (!user) {
        console.log(`Role backfill: no account named "${name}" — skipping.`);
        continue;
      }
      if (user.role === role) continue; // already correct
      await prisma.user.update({ where: { id: user.id }, data: { role } });
      console.log(`Role backfill: ${user.username} ${user.role || "USER"} -> ${role}`);
      changed++;
    } catch (err: any) {
      console.error(`Role backfill: "${name}" failed —`, err?.message || err);
    }
  }
  return changed;
}

async function main() {
  const n = (await apply(LEAD_DEV, "LEAD_DEV")) + (await apply(ADMINS, "ADMIN"));
  console.log(n ? `Role backfill: updated ${n} account(s).` : "Role backfill: nothing to do.");
}

main()
  .catch((e) => console.error("Role backfill failed:", e))
  .finally(async () => {
    await prisma.$disconnect();
  });
