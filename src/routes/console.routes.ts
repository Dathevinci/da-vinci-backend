import { Router } from "express";
import {
  consoleSession,
  listUsers,
  getUserDossier,
  setUserRole,
  adjustPoints,
  grantItem,
  revokeItem,
  notifyUser,
  deleteUserAccount,
  economyOverview,
  economyLedger,
  reverseLedgerEntry,
  shopCatalogStats,
} from "../controllers/console.controller";
import {
  opsStatus,
  setMaintenance,
  listInvites,
  createInvites,
  revokeInvite,
  publishAnnouncement,
  listComments,
  deleteCommentAsLeadDev,
  pinCommentAsLeadDev,
  insights,
  listAudit,
} from "../controllers/consoleOps.controller";
import { raidDevSetHp, raidDevSettleNow } from "../controllers/raid.controller";

/**
 * Lead-Dev-only console API.
 *
 * There is no route-level auth middleware here on purpose: authorization lives
 * inside every handler via requireStaff(req, res, { leadDevOnly: true }). A
 * router-level guard would be easy to bypass by adding a route below it, and it
 * would hide the check from whoever reads the controller next.
 *
 * Literal segments are declared before any "/:id" route — the same ordering
 * gotcha user.routes.ts already handles for /gift and /purchase.
 */
const router = Router();

// Session
router.get("/me", consoleSession);

// Insights + audit (literal, before /users/:id style routes)
router.get("/insights", insights);
router.get("/audit", listAudit);

// Economy
router.get("/economy/overview", economyOverview);
router.get("/economy/ledger", economyLedger);
router.post("/economy/ledger/:id/reverse", reverseLedgerEntry);

// Shop
router.get("/shop/catalog", shopCatalogStats);

// Site operations
router.get("/ops/status", opsStatus);
router.post("/ops/maintenance", setMaintenance);
router.get("/ops/invites", listInvites);
router.post("/ops/invites", createInvites);
router.delete("/ops/invites/:id", revokeInvite);
router.post("/ops/announcements", publishAnnouncement);
router.post("/ops/raid-hp", raidDevSetHp);
router.post("/ops/raid-settle", raidDevSettleNow);

// Moderation
router.get("/moderation/comments", listComments);
router.delete("/moderation/comments/:id", deleteCommentAsLeadDev);
router.post("/moderation/comments/:id/pin", pinCommentAsLeadDev);

// Users — parameterised routes last
router.get("/users", listUsers);
router.get("/users/:id", getUserDossier);
router.post("/users/:id/role", setUserRole);
router.post("/users/:id/points", adjustPoints);
router.post("/users/:id/grant-item", grantItem);
router.post("/users/:id/revoke-item", revokeItem);
router.post("/users/:id/notify", notifyUser);
router.delete("/users/:id", deleteUserAccount);

export default router;
