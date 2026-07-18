import { prisma } from "../lib/prisma";

/**
 * Scans content for @username mentions and creates notifications for each mentioned user.
 * @param content - The text content to scan
 * @param actorId - The user who wrote the content (to avoid self-notifications)
 * @param link - An optional link to associate with the notification
 */
export async function processMentions(content: string, actorId: string, link?: string) {
  const mentionRegex = /@([a-zA-Z0-9_]+)/g;
  const matches = content.matchAll(mentionRegex);
  const mentionedUsernames = new Set<string>();

  for (const match of matches) {
    mentionedUsernames.add(match[1]);
  }

  if (mentionedUsernames.size === 0) return;

  const actor = await prisma.user.findUnique({ where: { id: actorId } });
  if (!actor) return;

  for (const username of mentionedUsernames) {
    const mentionedUser = await prisma.user.findFirst({
      where: { username: { equals: username, mode: "insensitive" } }
    });

    if (mentionedUser && mentionedUser.id !== actorId) {
      await prisma.notification.create({
        data: {
          userId: mentionedUser.id,
          actorId,
          type: "mention",
          message: `${actor.username} mentioned you in a post.`,
          link: link || "/community"
        }
      });
    }
  }
}
