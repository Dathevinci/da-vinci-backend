import { prisma } from "./prisma";
import { RETIRED_CARD_IDS } from "../data/cardCatalog";

/**
 * SETTLE THE DUELS THE CARD WIPE STRANDED.
 *
 * A deck holding a retired card resolves to nothing: duelRules returns null
 * for an unknown id and the side is built from the survivors, so a duel can
 * end up with zero fighters. Neither player can act, the match never
 * finishes, and the stakes are already escrowed with no code path that gives
 * them back. The duel controller's own comments warn about exactly this.
 *
 * HOW MUCH IS ESCROWED, traced rather than assumed:
 *   PENDING — creating the duel debited the CHALLENGER only
 *             (duel.controller.ts:191). Refund one stake.
 *   ACTIVE  — accepting debited the OPPONENT too
 *             (duel.controller.ts:326). Refund two.
 * Refunding a PENDING duel as if both had paid would mint AP from nothing;
 * refunding an ACTIVE one as if only one had would rob the opponent. The
 * distinction is the whole point of this file.
 *
 * Terminal statuses match what the controller already uses, so these duels
 * look like ordinary declines and finishes rather than a new state nothing
 * else understands: PENDING becomes DECLINED, ACTIVE becomes FINISHED with no
 * winner. Naturally idempotent — a second run finds nothing still PENDING or
 * ACTIVE with a retired card in it.
 */
export async function settleStrandedDuels(): Promise<void> {
  try {
    const retired = RETIRED_CARD_IDS;
    if (retired.length === 0) {
      console.log("Duel settlement: nothing retired — skipping.");
      return;
    }

    const stranded = await prisma.duel.findMany({
      where: {
        status: { in: ["PENDING", "ACTIVE"] },
        OR: [
          { challengerDeck: { hasSome: retired } },
          { opponentDeck: { hasSome: retired } },
        ],
      },
      select: {
        id: true, status: true, stake: true,
        challengerId: true, opponentId: true,
      },
    });

    if (stranded.length === 0) {
      console.log("Duel settlement: no stranded duels.");
      return;
    }

    let settled = 0;
    let refunded = 0;

    for (const d of stranded) {
      try {
        // Refund and status change move together: a refund without the status
        // change would pay out again on the next boot, and a status change
        // without the refund would strand the points permanently.
        await prisma.$transaction(async (tx) => {
          const ops: Promise<unknown>[] = [];

          // The challenger always paid — that happens at creation.
          ops.push(
            tx.user.update({
              where: { id: d.challengerId },
              data: { arisePoints: { increment: d.stake } },
            }) as unknown as Promise<unknown>
          );
          let returnedAp = d.stake;

          // The opponent only paid if they actually accepted.
          if (d.status === "ACTIVE") {
            ops.push(
              tx.user.update({
                where: { id: d.opponentId },
                data: { arisePoints: { increment: d.stake } },
              }) as unknown as Promise<unknown>
            );
            returnedAp += d.stake;
          }

          await Promise.all(ops);

          await tx.duel.update({
            where: { id: d.id },
            data: {
              status: d.status === "ACTIVE" ? "FINISHED" : "DECLINED",
              winnerId: null,
              turnUserId: null,
              finishedAt: new Date(),
            },
          });

          await tx.pointLog.create({
            data: {
              userId: d.challengerId,
              amount: d.stake,
              reason: "duel-refund:card-reset",
            },
          });
          if (d.status === "ACTIVE") {
            await tx.pointLog.create({
              data: {
                userId: d.opponentId,
                amount: d.stake,
                reason: "duel-refund:card-reset",
              },
            });
          }

          refunded += returnedAp;
        });
        settled++;
      } catch (err) {
        // One bad duel must not abort the sweep; the rest still need settling.
        console.error(`Duel settlement: skipped ${d.id}`, err);
      }
    }

    console.log(
      `Duel settlement: ${settled} of ${stranded.length} stranded duel(s) closed, ${refunded} AP returned.`
    );
  } catch (err) {
    console.error("Duel settlement failed:", err);
  }
}
