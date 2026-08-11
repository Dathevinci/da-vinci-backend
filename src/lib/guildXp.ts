import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * MEMBER XP → GUILD XP. The ONE place a member's personal earnings feed their
 * guild, called from every site on the server that increments User.xp.
 *
 * It is deliberately a single helper rather than a copied block: the share, the
 * boost and the treasury mint are one rule, and a second copy of that rule is
 * how two earn paths start paying guilds differently without anyone noticing.
 *
 * ── CLOSED LOOP (hard invariant) ────────────────────────────────────────────
 * The shards minted here land on the GUILD row and are guild-only forever.
 * There is no path — not here, not in guild.controller.ts, not at raid
 * settlement — that moves treasury shards into a personal balance. Members may
 * donate personal shards IN; nothing comes back OUT, and the only debits are
 * the guild purchases. Minting them beside XP is safe precisely because of
 * that: they can never be laundered back into a user's wallet.
 *
 * The member's own XP is NEVER touched here — the guild's share is minted on
 * top of it, so feeding your guild costs you nothing.
 */

/** The guild's cut of a member's personal XP. */
export const GUILD_XP_SHARE = 0.5;

/** Multiplier on the guild's cut while the XP Boost purchase is live. The
 *  MEMBER's own XP is untouched by it — only the guild's share is boosted. */
export const GUILD_XP_BOOST_MULT = 1.25;

/** Guild XP per treasury shard — the reference's "5 coins per 25 XP". */
export const GUILD_XP_PER_SHARD = 5;

/**
 * SCHEMA NOTE — REMOVE THE TWO `as any` ARG CASTS BELOW ONCE THE CLIENT IS
 * REGENERATED. `Guild.xpBoostUntil` and `GuildMember.xpContributed` land in
 * prisma/schema.prisma with the rest of guild progression; until
 * `prisma generate` has run against that schema, the generated client does not
 * know those two columns and the literals below would not typecheck. The casts
 * are scoped to the ARGUMENT objects only — the read's result is re-typed as
 * `MembershipRow` immediately, so everything downstream of the query stays
 * strictly typed. The emitted SQL is identical either way.
 */
type MembershipRow = {
  guildId: string;
  guild: { id: string; xpBoostUntil: Date | null } | null;
};

/**
 * Credit a member's guild for XP that member just earned.
 *
 * @param userId   the member who earned the XP
 * @param memberXp the PERSONAL xp just granted (not the guild's share)
 * @param tx       pass the transaction client when the caller is already
 *                 inside `$transaction`, so the credit commits atomically with
 *                 the earn instead of landing outside it
 *
 * Never throws. A guild-side failure must never fail a user's earn, so the
 * whole body is wrapped and errors are logged and swallowed. Caveat worth
 * knowing: when `tx` is supplied and a query here fails, Postgres has already
 * aborted that transaction — swallowing keeps this helper from being the thing
 * that reports it, but the caller's transaction is still doomed. That is why
 * every write below is an updateMany (see next paragraph): the realistic
 * failure — the guild disbanding mid-request — is made a zero-row match rather
 * than an error.
 *
 * updateMany, NEVER update: `update` throws P2025 when the row is gone, which
 * inside a caller's transaction poisons the whole thing. This exact trap has
 * already bitten raid.controller.ts once.
 */
export async function creditGuildXp(
  userId: string,
  memberXp: number,
  tx?: Prisma.TransactionClient
): Promise<void> {
  // No-op before touching the database at all. This runs on EVERY xp grant on
  // the site, so a zero/negative/garbage amount must cost zero queries.
  if (!Number.isFinite(memberXp) || memberXp <= 0) return;

  try {
    const db: Prisma.TransactionClient = tx ?? prisma;

    /**
     * ONE query for the whole no-guild path — and for the boost too.
     *
     * GuildMember.userId is @unique, so this is a single indexed lookup, and
     * the guild relation rides along on the same read rather than costing a
     * second round trip for `xpBoostUntil`. The overwhelmingly common case on
     * this site is "member is in no guild", and that case ends here.
     */
    const membership = (await db.guildMember.findUnique({
      where: { userId },
      select: {
        guildId: true,
        guild: { select: { id: true, xpBoostUntil: true } },
      },
    } as any)) as MembershipRow | null;

    const guild = membership?.guild;
    if (!guild) return;

    const boosted = !!guild.xpBoostUntil && guild.xpBoostUntil.getTime() > Date.now();
    // floor AFTER the boost, not before — the boost multiplies the share the
    // guild would otherwise have received, so 1.25× of a floored share is the
    // number the UI's "+25%" claim has to mean.
    const share = boosted
      ? Math.floor(Math.floor(memberXp * GUILD_XP_SHARE) * GUILD_XP_BOOST_MULT)
      : Math.floor(memberXp * GUILD_XP_SHARE);
    if (share <= 0) return;

    // TREASURY MINT — closed loop. These shards exist only to be SPENT on the
    // guild purchases; nothing ever pays them out to a member.
    const shards = Math.floor(share / GUILD_XP_PER_SHARD);

    await db.guild.updateMany({
      where: { id: guild.id },
      data: { xp: { increment: share }, shards: { increment: shards } },
    });

    // The same amount on the member's own contribution counter, so the roster
    // can rank who actually fed the guild.
    await db.guildMember.updateMany({
      where: { userId },
      data: { xpContributed: { increment: share } },
    } as any);
  } catch (err) {
    // Swallowed on purpose — see the doc comment. A guild ledger hiccup is
    // never allowed to turn a member's earn into a failed request.
    console.error("creditGuildXp failed", err);
  }
}

/**
 * THE REVERSAL — call this wherever a personal XP award is clawed back.
 *
 * Undoing a mint is NOT a treasury payout. The closed-loop invariant forbids
 * treasury shards reaching a person's wallet; it says nothing about deleting
 * shards that were never legitimately earned, and the two must not be confused.
 * Without this, any earn with a clawback becomes a guild-XP farm: deleteComment
 * refunds the member's XP but the guild would keep its cut, so post→delete in a
 * loop climbs the 1–100 ladder for free while the member's own XP never moves.
 *
 * Clamped at zero in SQL (GREATEST) rather than read-then-write, so concurrent
 * reversals can't race a guild's counters negative.
 */
export async function debitGuildXp(
  userId: string,
  memberXp: number,
  tx?: Prisma.TransactionClient
): Promise<void> {
  if (!Number.isFinite(memberXp) || memberXp <= 0) return;

  try {
    const db: Prisma.TransactionClient = tx ?? prisma;

    const membership = (await db.guildMember.findUnique({
      where: { userId },
      select: {
        guildId: true,
        guild: { select: { id: true, xpBoostUntil: true } },
      },
    } as any)) as MembershipRow | null;

    const guild = membership?.guild;
    if (!guild) return;

    // Mirrors the credit formula exactly, including the boost state. A boost
    // that expired between the award and the clawback can only make this
    // reverse LESS than it granted — never more — so the asymmetry can't be
    // farmed in the other direction.
    const boosted = !!guild.xpBoostUntil && guild.xpBoostUntil.getTime() > Date.now();
    const share = boosted
      ? Math.floor(Math.floor(memberXp * GUILD_XP_SHARE) * GUILD_XP_BOOST_MULT)
      : Math.floor(memberXp * GUILD_XP_SHARE);
    if (share <= 0) return;

    const shards = Math.floor(share / GUILD_XP_PER_SHARD);

    await db.$executeRaw`
      UPDATE "Guild"
         SET "xp" = GREATEST(0, "xp" - ${share}),
             "shards" = GREATEST(0, "shards" - ${shards})
       WHERE "id" = ${guild.id}`;

    await db.$executeRaw`
      UPDATE "GuildMember"
         SET "xpContributed" = GREATEST(0, "xpContributed" - ${share})
       WHERE "userId" = ${userId}`;
  } catch (err) {
    // Same posture as the credit: a ledger hiccup never fails the user's
    // request. The worst case is a few un-reversed guild XP, not a 500.
    console.error("debitGuildXp failed", err);
  }
}
