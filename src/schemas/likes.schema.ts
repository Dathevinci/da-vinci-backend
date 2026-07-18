import { z } from "zod";

export const addLikeSchema = z.object({
  body: z.object({
    userId: z.string(),
    anilistId: z.number(),
    title: z.string(),
    coverImage: z.string().optional(),
  }),
});
