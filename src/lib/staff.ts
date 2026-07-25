import { prisma } from "./prisma";
import { getActorId } from "./jwt";
import { getRole, Role } from "../utils/economy";

/**
 * The single source of truth for "who is acting, and are they staff?".
 *
 * Before this, every privileged endpoint re-implemented its own check, and they
 * had drifted badly:
 *   · comment.controller + announcement.controller each inlined their own
 *     hardcoded username array, so an admin added to the shared list (e.g.
 *     "ash") silently had economy perks but NO moderation powers, and any
 *     admin who renamed lost everything.
 *   · the actor was read from `req.body.userId` — unverified client input —
 *     so anyone who knew a staff user id could delete comments, edit posts, or
 *     mint 500 Arise Points via Divine Blessing.
 *
 * resolveActor takes the identity from the VERIFIED JWT only, then resolves the
 * role from the persistent `role` column (authoritative — survives renames),
 * falling back to getRole(username) for accounts not yet backfilled, and finally
 * to the legacy `isAdmin` boolean column.
 */
export interface Actor {
  id: string;
  username: string;
  role: Role;
  isStaff: boolean;    // ADMIN or LEAD_DEV
  isLeadDev: boolean;
}

export async function resolveActor(req: any): Promise<Actor | null> {
  const actorId = getActorId(req);
  if (!actorId) return null;

  const user = await prisma.user.findUnique({
    where: { id: actorId },
    select: { id: true, username: true, role: true, isAdmin: true },
  });
  if (!user) return null;

  const stored = (user as any).role as string | undefined;
  let role: Role = stored && stored !== "USER" ? (stored as Role) : getRole(user.username);
  if (role === "USER" && (user as any).isAdmin) role = "ADMIN";

  return {
    id: user.id,
    username: user.username,
    role,
    isStaff: role === "ADMIN" || role === "LEAD_DEV",
    isLeadDev: role === "LEAD_DEV",
  };
}

/**
 * Guard for staff-only endpoints. Responds and returns null when the caller
 * isn't proven staff; otherwise returns the actor.
 *
 * HARD gate by design: these actions are destructive or mint currency, so an
 * unauthenticated (pre-JWT, grandfathered) session must NOT pass. Staff can
 * always sign in again to get a token.
 */
export async function requireStaff(req: any, res: any, opts: { leadDevOnly?: boolean } = {}) {
  const actor = await resolveActor(req);
  if (!actor) {
    res.status(401).json({ success: false, message: "Sign in again to perform this action." });
    return null;
  }
  if (opts.leadDevOnly ? !actor.isLeadDev : !actor.isStaff) {
    res.status(403).json({ success: false, message: "You don't have permission to do that." });
    return null;
  }
  return actor;
}
