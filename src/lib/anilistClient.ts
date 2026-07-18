import axios from "axios";
import { env } from "../config/env";

export const anilistClient = axios.create({
  baseURL: env.ANILIST_API_URL,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});
