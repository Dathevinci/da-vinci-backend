import { prisma } from "../lib/prisma";

/**
 * How many mentions one piece of content may notify. A comment that lists 200
 * usernames is a fan-out attack, not a conversation: without this cap it wrote
 * 200 notification rows (and, before the batching below, ran 200 queries) off a
 * single POST. The FIRST ten unique names win; the rest are silently ignored —
 * the post itself is untouched, only the pinging stops.
 */
export const MAX_MENTIONS_PER_POST = 10;

/**
 * Scans content for @username mentions and creates notifications for the users
 * they resolve to.
 *
 * COST: two reads (the actor + one batched user lookup for every mentioned
 * name) and one batched write, regardless of how many names were typed. It used
 * to be one findFirst PER username.
 *
 * NEVER THROWS. Every caller awaits this AFTER its post/comment/message row is
 * already committed, so a failure in here used to take down a request whose
 * real work had succeeded — the client saw an error for a comment that exists.
 * Everything is wrapped and logged instead.
 *
 * @param content - The text content to scan. May be empty (a GIF on its own is
 *                  a valid comment) — that returns early rather than throwing.
 * @param actorId - The user who wrote the content. Never notified about
 *                  themselves.
 * @param link    - Where the notification click lands. It MATTERS: the callers
 *                  are no longer just the community feed — comment.controller
 *                  passes a comment deep-link, announcement.controller passes
 *                  /updates, and guildChat.controller passes /guild/<id>. A
 *                  missing link falls back to /community, which for a guild
 *                  message would drop the reader on the wrong page entirely.
 * @param allowedUserIds - Optional ALLOW-LIST of user ids that may be notified.
 *                  Omit it (public surfaces: comments, updates) and anyone
 *                  mentioned is notified. Pass one (guild chat) and mentions
 *                  resolving outside the list are dropped — guild chat is a
 *                  members-only room, so @-ing an outsider must not ping them
 *                  into a conversation they cannot open. Passing an EMPTY list
 *                  means "notify nobody", not "no restriction".
 */
export async function processMentions(
  content: string,
  actorId: string,
  link?: string,
  allowedUserIds?: string[] | null
): Promise<void> {
  try {
    // A post can legitimately have no text — a GIF on its own is a valid
    // comment. Without this guard, content.matchAll threw on every captionless
    // post and took the whole request down after the comment had already been
    // created.
    if (typeof content !== "string" || content.length === 0) return;

    const mentionRegex = /@([a-zA-Z0-9_]+)/g;

    // Deduped case-insensitively (keyed on the lowercase form) but stored as
    // TYPED, because the lookup below matches case-insensitively anyway and the
    // typed form is what a human wrote. Stops at MAX_MENTIONS_PER_POST unique
    // names — later ones are dropped, not queried.
    const uniqueNames = new Map<string, string>();
    for (const match of content.matchAll(mentionRegex)) {
      const name = match[1];
      if (!name) continue;
      const key = name.toLowerCase();
      if (!uniqueNames.has(key)) uniqueNames.set(key, name);
      if (uniqueNames.size >= MAX_MENTIONS_PER_POST) break;
    }
    if (uniqueNames.size === 0) return;

    // An empty allow-list is a real answer ("nobody here may be pinged"), so it
    // short-circuits instead of degrading into "no restriction".
    const allow = allowedUserIds ? new Set(allowedUserIds) : null;
    if (allow && allow.size === 0) return;

    const names = Array.from(uniqueNames.values());

    // ONE findMany for every mentioned name, plus one actor lookup, run
    // together. The where clause is an OR of case-insensitive `equals` rather
    // than a single `in`: `mode: "insensitive"` is reliably honoured on
    // `equals` (it is the form the rest of this codebase already trusts for
    // username matching), and case-insensitivity is the invariant here — "Ash"
    // and "ash" are the same person. It is still one query, with at most
    // MAX_MENTIONS_PER_POST clauses.
    const [actor, mentionedUsers] = await Promise.all([
      prisma.user.findUnique({ where: { id: actorId }, select: { username: true } }),
      prisma.user.findMany({
        where: { OR: names.map((name) => ({ username: { equals: name, mode: "insensitive" as const } })) },
        select: { id: true },
      }),
    ]);
    if (!actor) return;

    const recipients = mentionedUsers.filter(
      (u) => u.id !== actorId && (!allow || allow.has(u.id))
    );
    if (recipients.length === 0) return;

    await prisma.notification.createMany({
      data: recipients.map((u) => ({
        userId: u.id,
        actorId,
        type: "mention",
        message: `${actor.username} mentioned you in a post.`,
        link: link || "/community",
      })),
    });
  } catch (error) {
    // Deliberately swallowed — see the NEVER THROWS note above. The content the
    // mention lived in is already saved; losing a notification is a far smaller
    // failure than losing the post.
    console.error("[mentions] failed to process mentions:", error);
  }
}
