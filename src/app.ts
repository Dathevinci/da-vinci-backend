import express from "express";
import cors from "cors";
import helmet from "helmet";
import { corsOptions } from "./config/cors";
import { apiLimiter } from "./middleware/rateLimiter";
import dashboardRoutes from "./routes/dashboard.routes";
import animeRoutes from "./routes/anime.routes";
import searchRoutes from "./routes/search.routes";
import calendarRoutes from "./routes/calendar.routes";
import userRoutes from "./routes/user.routes";
import watchlistRoutes from "./routes/watchlist.routes";
import likesRoutes from "./routes/likes.routes";
import commentRoutes from "./routes/comment.routes";
import messageRoutes from "./routes/message.routes";
import systemRoutes from "./routes/system.routes";
import announcementRoutes from "./routes/announcement.routes";
import authRoutes from "./routes/auth.routes";
import notificationRoutes from "./routes/notification.routes";
import inviteRoutes from "./routes/invite.routes";
import novelRoutes from "./routes/novel.routes";
import manhwaBookmarkRoutes from "./routes/manhwaBookmarks";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

// Behind Render's reverse proxy: trust the first proxy hop so req.ip is the
// real client IP. Without this, the rate limiters would bucket every user into
// the single proxy IP and could lock out the whole userbase.
app.set("trust proxy", 1);

// Security headers + don't advertise the framework.
app.disable("x-powered-by");
app.use(helmet());

app.use(cors(corsOptions));
app.use(express.json({ limit: "100kb" }));

// Baseline rate limit on the whole API (auth routes get a stricter limiter of
// their own inside auth.routes.ts).
app.use("/api", apiLimiter);

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
app.use("/api/likes", likesRoutes);
app.use("/api/comments", commentRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/system", systemRoutes);
app.use("/api/announcements", announcementRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/invites", inviteRoutes);
app.use("/api/novels", novelRoutes);
app.use("/api/manhwa-bookmarks", manhwaBookmarkRoutes);

// Error Handler must be last
app.use(errorHandler);

export default app;
