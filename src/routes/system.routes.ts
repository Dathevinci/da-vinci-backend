import { Router } from "express";
import { getSystemStatus, setSystemMaintenance } from "../controllers/system.controller";

const router = Router();

router.get("/status", getSystemStatus);
router.post("/maintenance", setSystemMaintenance);

export default router;
