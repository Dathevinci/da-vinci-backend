import { Router } from "express";
import express from "express";
import { kofiWebhook, kofiStats } from "../controllers/kofi.controller";

const router = Router();

// Ko-fi POSTs application/x-www-form-urlencoded (a single `data` field), so this
// route needs the urlencoded parser regardless of the global JSON parser.
router.post("/webhook", express.urlencoded({ extended: true }), kofiWebhook);

// Public stats for the Support page (month-to-date total + recent supporters).
router.get("/stats", kofiStats);

export default router;
