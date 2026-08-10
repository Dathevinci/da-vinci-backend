import { Router } from "express";
import {
  createGuild, listGuilds, getGuild, joinGuild, leaveGuild,
  transferLeadership, kickMember, setCoLeader, updateGuild,
  createLoan, endLoan, myLoans,
} from "../controllers/guild.controller";

const router = Router();

// Every write is JWT-hard-gated inside the controller. Route ORDER matters:
// the static paths (/mine/loans, /leave, /loans/:loanId) must register before
// the /:id family or Express hands them to the param routes.
router.post("/", createGuild);
router.get("/", listGuilds);
router.get("/mine/loans", myLoans);
router.post("/leave", leaveGuild);
router.delete("/loans/:loanId", endLoan);
router.get("/:id", getGuild);
router.post("/:id/join", joinGuild);
router.post("/:id/transfer", transferLeadership);
router.post("/:id/kick", kickMember);
router.post("/:id/co-leader", setCoLeader);
router.patch("/:id", updateGuild);
router.post("/:id/loans", createLoan);

export default router;
