import { Router } from "express";
import { proxyImageHandler } from "../controllers/proxy.controller";

const router = Router();

router.get("/image", proxyImageHandler);

export default router;
