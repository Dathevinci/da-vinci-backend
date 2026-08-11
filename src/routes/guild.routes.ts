import { Router } from "express";
import {
  createGuild, listGuilds, getGuild, joinGuild, leaveGuild,
  transferLeadership, kickMember, setCoLeader, updateGuild, disbandGuild,
  createLoan, endLoan, myLoans, guildOfUser,
  createRole, updateRole, deleteRole, assignRole,
  listEmojis, createEmoji, deleteEmoji,
  inviteMember, listInvites, revokeInvite, myInvites, acceptInvite, declineInvite,
  donateShards, purchaseUpgrade,
} from "../controllers/guild.controller";

const router = Router();

// Every write is JWT-hard-gated inside the controller. Route ORDER matters:
// the static-prefix paths (/mine/loans, /leave, /loans/:loanId, /of/:userId)
// must register before the /:id family or Express hands them to the param
// routes ("/of" would match as a guild id).
//
// POST /tags belongs to that static-prefix block by shape but deliberately
// does NOT live here: it rides guildTags.routes.ts, mounted above the global
// limiter with its own tagLimiter (see app.ts). Registering it here too would
// give the chip a second, limiter-less path to the same handler.
router.post("/", createGuild);
router.get("/", listGuilds);
router.get("/mine/loans", myLoans);
router.get("/mine/invites", myInvites);
router.get("/of/:userId", guildOfUser);
router.post("/leave", leaveGuild);
router.delete("/loans/:loanId", endLoan);
// The invitee's side of an invite. Static "/invites" prefix, so these belong
// in this block: registered after the /:id family, "invites" would be read as
// a guild id by any same-shape param route added later.
router.post("/invites/:inviteId/accept", acceptInvite);
router.post("/invites/:inviteId/decline", declineInvite);
router.get("/:id", getGuild);
router.post("/:id/join", joinGuild);
router.post("/:id/transfer", transferLeadership);
router.post("/:id/kick", kickMember);
router.post("/:id/co-leader", setCoLeader);
router.post("/:id/roles", createRole);
router.patch("/:id/roles/:roleId", updateRole);
router.delete("/:id/roles/:roleId", deleteRole);
router.post("/:id/members/:targetId/role", assignRole);
// Custom emoji. In the /:id family, with a LITERAL second segment ("emojis"),
// so nothing above can swallow them: "/:id" matches a single segment only, and
// the /:id/roles and /:id/members families claim different literals. The GET
// is members-only inside the handler (this is guild-chat art, not a public
// list); both writes ride the same editGuild gate as PATCH /:id.
//
// These live on the MAIN mount, below the global limiter, deliberately: the
// chat router above the limiter matches only /:id/messages*, and an emoji
// catalog is fetched once per room open, not polled every 8s — it has no
// reason to spend the chat budget.
router.get("/:id/emojis", listEmojis);
router.post("/:id/emojis", createEmoji);
router.delete("/:id/emojis/:emojiId", deleteEmoji);
// The officers' side of invites (send / list / revoke).
router.post("/:id/invites", inviteMember);
router.get("/:id/invites", listInvites);
router.delete("/:id/invites/:inviteId", revokeInvite);
router.post("/:id/donate", donateShards);
router.post("/:id/purchase", purchaseUpgrade);
router.patch("/:id", updateGuild);
router.delete("/:id", disbandGuild);
router.post("/:id/loans", createLoan);

export default router;
