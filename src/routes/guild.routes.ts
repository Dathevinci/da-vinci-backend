import { Router } from "express";
import {
  createGuild, listGuilds, getGuild, joinGuild, leaveGuild,
  transferLeadership, kickMember, setCoLeader, updateGuild,
  createLoan, endLoan, myLoans, guildOfUser,
  createRole, updateRole, deleteRole, assignRole,
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
router.get("/of/:userId", guildOfUser);
router.post("/leave", leaveGuild);
router.delete("/loans/:loanId", endLoan);
router.get("/:id", getGuild);
router.post("/:id/join", joinGuild);
router.post("/:id/transfer", transferLeadership);
router.post("/:id/kick", kickMember);
router.post("/:id/co-leader", setCoLeader);
router.post("/:id/roles", createRole);
router.patch("/:id/roles/:roleId", updateRole);
router.delete("/:id/roles/:roleId", deleteRole);
router.post("/:id/members/:targetId/role", assignRole);
router.patch("/:id", updateGuild);
router.post("/:id/loans", createLoan);

export default router;
