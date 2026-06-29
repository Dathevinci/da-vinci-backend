import express from "express";
import cors from "cors";
import { corsOptions } from "./config/cors";
import dashboardRoutes from "./routes/dashboard.routes";
import animeRoutes from "./routes/anime.routes";
import searchRoutes from "./routes/search.routes";
import calendarRoutes from "./routes/calendar.routes";
import userRoutes from "./routes/user.routes";
import watchlistRoutes from "./routes/watchlist.routes";
import commentRoutes from "./routes/comment.routes";
import messageRoutes from "./routes/message.routes";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

app.use(cors(corsOptions));
app.use(express.json());

// Basic health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Mount routers
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/anime", animeRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/calendar", calendarRoutes);
app.use("/api/users", userRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/comments", commentRoutes);
app.use("/api/messages", messageRoutes);

// Error Handler must be last
app.use(errorHandler);

export default app;
