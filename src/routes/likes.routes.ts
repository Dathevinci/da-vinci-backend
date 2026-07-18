import { Router } from "express";
import { addLike, getLikes, removeLike } from "../controllers/likes.controller";
import { validateRequest } from "../middleware/validateRequest";
import { addLikeSchema } from "../schemas/likes.schema";

const router = Router();

router.post("/", validateRequest(addLikeSchema), addLike);
router.get("/:userId", getLikes);
router.delete("/:userId/:anilistId", removeLike);

export default router;
