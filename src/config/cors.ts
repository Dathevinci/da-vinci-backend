import cors from "cors";
import { env } from "./env";

export const corsOptions: cors.CorsOptions = {
  // Allow all origins to reflect the request origin to support multiple Vercel frontends
  origin: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
};
