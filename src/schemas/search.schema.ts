import { z } from "zod";

export const searchSchema = z.object({
  query: z.object({
    q: z.string().optional(),
    status: z.enum(["RELEASING", "NOT_YET_RELEASED", "FINISHED", "CANCELLED", "HIATUS"]).optional(),
    season: z.enum(["WINTER", "SPRING", "SUMMER", "FALL"]).optional(),
    year: z.string().transform(Number).optional(),
    page: z.string().transform(Number).default(1),
  }),
});
