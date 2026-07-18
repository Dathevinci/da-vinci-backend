import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default("5000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string(),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  CACHE_TTL_SECONDS: z.string().transform((val) => parseInt(val, 10)).default(900),
  ANILIST_API_URL: z.string().url().default("https://graphql.anilist.co"),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error("❌ Invalid environment variables:", _env.error.format());
  process.exit(1);
}

export const env = _env.data;
