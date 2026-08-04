import { prisma } from "./prisma";
import { heldCardIds } from "./showcase";

/**
 * BOOT-TIME PRUNE, safe to run on every boot.
 *
 * The profile read already filters dead pins (lib/showcase.ts), so this is not
 * what fixes the user-visible bug — it just stops the dead ids riding along in
 * the row forever, where the next thing to read the column would inherit the
 * same trap.
 *
 * Shaped like printBackfill: called after listen(), never blocking it, and it
 * swallows everything. A prune that throws must not be able to take the API
 * down — this is housekeeping, not a migration.
 *
 * Idempotent: it writes only when something actually drops, so the second boot
 * finds nothing and touches no rows.
 *
 * The escrow rule from showcase.ts carries here too, and matters MORE: this
 * one writes. Pruning a card that is merely sitting in your own active listing
 * would permanently destroy a pin the user never removed, and cancelling the
 * listing would not bring it back.
 */
export async function pruneOrphanedShowcases(): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      where: { showcaseCards: { isEmpty: false } },
      select: { id: true, showcaseCards: true },
    });

    let cleaned = 0;
    let dropped = 0;

    for (const user of users) {
      try {
        const held = await heldCardIds(user.id, user.showcaseCards);
        const kept = user.showcaseCards.filter((id) => held.has(id));
        if (kept.length === user.showcaseCards.length) continue;

        dropped += user.showcaseCards.length - kept.length;
        cleaned++;
        await prisma.user.update({
          where: { id: user.id },
          data: { showcaseCards: { set: kept } },
        });
      } catch (err) {
        // One unreadable user must not abort the sweep, and must never be
        // written as an empty showcase on the strength of a failed read.
        console.error(`Showcase prune: skipped ${user.id}`, err);
      }
    }

    // Always log, including the no-op: on Render this line is the only proof
    // the job ran at all.
    console.log(`Showcase prune: ${cleaned} profile(s) cleaned, ${dropped} dead pin(s) dropped.`);
  } catch (err) {
    console.error("Showcase prune failed:", err);
  }
}
