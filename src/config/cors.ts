import cors from "cors";
import { env } from "./env";

export const corsOptions: cors.CorsOptions = {
  origin: env.FRONTEND_URL,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
};
