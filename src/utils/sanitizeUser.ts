// Strip sensitive fields from user objects before they go to a client. Done in
// application code (not via Prisma `omit`, which this Prisma setup rejects) so
// it works on any Prisma version.
//
// - password + discordId: never needed by the client — removed everywhere.
// - email: kept on the OWNER's own responses (login/signup/own profile update)
//   in case the client needs it, but removed when viewing OTHER users and
//   always removed from nested follower/following rows.

function drop(u: any, fields: string[]): any {
  if (!u || typeof u !== "object") return u;
  const o: any = { ...u };
  for (const f of fields) delete o[f];
  return o;
}

// Follower/following relations embed OTHER users — always strip their PII.
function stripRelations(u: any): any {
  if (!u || typeof u !== "object") return u;
  if (Array.isArray(u.followers)) {
    u.followers = u.followers.map((f: any) =>
      f && f.follower ? { ...f, follower: drop(f.follower, ["password", "email", "discordId"]) } : f
    );
  }
  if (Array.isArray(u.following)) {
    u.following = u.following.map((f: any) =>
      f && f.following ? { ...f, following: drop(f.following, ["password", "email", "discordId"]) } : f
    );
  }
  return u;
}

// For a user viewing THEIR OWN account (login, signup, own profile update).
export function sanitizeOwnUser(user: any): any {
  if (!user) return user;
  return stripRelations(drop(user, ["password", "discordId"]));
}

// For any user visible to OTHERS (profiles, community list, followers).
export function sanitizePublicUser(user: any): any {
  if (!user) return user;
  return stripRelations(drop(user, ["password", "email", "discordId"]));
}

export function sanitizePublicUsers(users: any): any {
  return Array.isArray(users) ? users.map((u) => sanitizePublicUser(u)) : users;
}
