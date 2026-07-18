import { z } from "zod";

export const createUserSchema = z.object({
  body: z.object({
    username: z.string().min(3),
    email: z.string().email(),
  }),
});

export const addWatchlistSchema = z.object({
  body: z.object({
    userId: z.string(),
    anilistId: z.number(),
    title: z.string(),
    coverImage: z.string().optional(),
    status: z.enum(["INTERESTED", "WATCHING", "WAITING", "FINISHED", "DROPPED"]),
    score: z.number().min(0).max(100).optional(),
    notes: z.string().optional(),
  }),
});

export const updateWatchlistSchema = z.object({
  body: z.object({
    status: z.enum(["INTERESTED", "WATCHING", "WAITING", "FINISHED", "DROPPED"]).optional(),
    score: z.number().min(0).max(100).optional(),
    notes: z.string().optional(),
  }),
  params: z.object({
    id: z.string(),
  }),
});
