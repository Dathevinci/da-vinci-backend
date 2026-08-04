import { prisma } from "./prisma";
import { RETIRED_CARD_IDS } from "../data/cardCatalog";

/**
 * CARD RESET — clears the progress the old card game left on profiles and the
 * ladder, so the rebuild starts from a clean board.
 *
 * MUST run after the refund, never beside it. It is chained off the refund's
 * completion in server.ts rather than fired alongside, because both touch the
 * same users and the refund is the one that must win.
 *
 * WHAT IT CLEARS
 *   showcaseCards   — pins, most of which point at cards about to be wiped
 *   cardTitle       — the title earned from completing a set
 *   equippedTitles  — titles worn on the profile
 *   claimedSets     — which set rewards have been paid, so sets can be re-earned
 *   DuelRating      — rating, wins, losses, streak: the ladder itself
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 *   arisePoints — the refund just paid into this. Clearing it would destroy
 *                 the compensation in the same breath as granting it.
 *   shards      — earned currency, not card progress, and still spendable on
 *                 the workbench.
 *   xp          — earned by watching anime and reading manhwa and novels, not
 *                 by pulling cards. Resetting it would wipe progress that has
 *                 nothing to do with the card game.
 *
 * Idempotent through a zero-amount PointLog marker, the same shape the refund
 * uses: this fires on every boot and Render restarts freely.
 */

// v2: the first pass cleared profiles and the ladder; this one also removes
// the owned rows for retired cards. Re-running the profile clear is harmless
// (clearing an already-empty field is a no-op), so the marker simply moves on.
const RESET_MARKER = "card-reset-progress-v2";

export async function resetCardProgress(): Promise<void> {
  try {
    const done = await prisma.pointLog.findFirst({ where: { reason: RESET_MARKER } });
    if (done) {
      console.log("Card reset progress: already done — skipping.");
      return;
    }

    // Only users who actually carry something to clear, so the marker row
    // count reflects real work rather than the whole table.
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { showcaseCards: { isEmpty: false } },
          { equippedTitles: { isEmpty: false } },
          { claimedSets: { isEmpty: false } },
          { NOT: { cardTitle: null } },
        ],
      },
      select: { id: true },
    });

    let cleared = 0;
    for (const u of users) {
      try {
        await prisma.user.update({
          where: { id: u.id },
          data: {
            showcaseCards: { set: [] },
            equippedTitles: { set: [] },
            claimedSets: { set: [] },
            cardTitle: null,
          },
        });
        cleared++;
      } catch (err) {
        console.error(`Card reset progress: skipped ${u.id}`, err);
      }
    }

    // The ladder. Deleting the rows rather than zeroing them means a player
    // who never duels again simply is not ranked, instead of sitting at the
    // bottom of the board forever.
    const ladder = await prisma.duelRating.deleteMany({});

    /**
     * The collections themselves. The catalogue no longer defines these cards,
     * and the collection endpoint does no catalogue join — so leaving the rows
     * would hand the binder ids it cannot resolve and render blank slots that
     * nothing can clear.
     *
     * Listings go first: a listing is the custody record for escrowed copies,
     * so deleting the cards while a listing still points at them would leave a
     * price tag attached to nothing. Holders were already paid for escrowed
     * copies in the refund pass.
     */
    const retired = RETIRED_CARD_IDS;
    let listings = { count: 0 };
    let prints = { count: 0 };
    let owned = { count: 0 };
    if (retired.length > 0) {
      listings = await prisma.cardListing.deleteMany({ where: { cardId: { in: retired } } });
      prints = await prisma.cardPrint.deleteMany({ where: { cardId: { in: retired } } });
      owned = await prisma.userCard.deleteMany({ where: { cardId: { in: retired } } });
    }

    // One marker for the whole job — this is a global reset, not a per-user
    // one, so a single row is what makes it idempotent.
    const [anyUser] = await prisma.user.findMany({ select: { id: true }, take: 1 });
    if (anyUser) {
      await prisma.pointLog.create({
        data: { userId: anyUser.id, amount: 0, reason: RESET_MARKER },
      });
    }

    console.log(
      `Card reset progress: ${cleared} profile(s) cleared, ${ladder.count} ladder row(s) removed, ` +
      `${owned.count} owned card row(s), ${prints.count} print(s) and ${listings.count} listing(s) deleted ` +
      `across ${retired.length} retired card(s).`
    );
  } catch (err) {
    console.error("Card reset progress failed:", err);
  }
}
