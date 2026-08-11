import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import { corsOptions } from "./config/cors";
import { apiLimiter, consoleLimiter } from "./middleware/rateLimiter";
import dashboardRoutes from "./routes/dashboard.routes";
import animeRoutes from "./routes/anime.routes";
import searchRoutes from "./routes/search.routes";
import calendarRoutes from "./routes/calendar.routes";
import torrentRoutes from "./routes/torrent.routes";
import subtitleRoutes from "./routes/subtitle.routes";
import userRoutes from "./routes/user.routes";
import watchlistRoutes from "./routes/watchlist.routes";
import likesRoutes from "./routes/likes.routes";
import commentRoutes from "./routes/comment.routes";
import ratingRoutes from "./routes/rating.routes";
import pollRoutes from "./routes/poll.routes";
import gemRoutes from "./routes/gem.routes";
import messageRoutes from "./routes/message.routes";
import systemRoutes from "./routes/system.routes";
import announcementRoutes from "./routes/announcement.routes";
import authRoutes from "./routes/auth.routes";
import notificationRoutes from "./routes/notification.routes";
import inviteRoutes from "./routes/invite.routes";
import novelRoutes from "./routes/novel.routes";
import manhwaBookmarkRoutes from "./routes/manhwaBookmarks";
import novelBookmarkRoutes from "./routes/novelBookmarks";
import kofiRoutes from "./routes/kofi.routes";
import raidRoutes from "./routes/raid.routes";
import guildRoutes from "./routes/guild.routes";
import guildChatRoutes from "./routes/guildChat.routes";
import guildTagsRoutes from "./routes/guildTags.routes";
import consoleRoutes from "./routes/console.routes";
import auctionRoutes from "./routes/auction.routes";
import cardRoutes from "./routes/card.routes";
import duelRoutes from "./routes/duel.routes";
import marketRoutes from "./routes/market.routes";
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
// gzip every response. The catalog alone (every card, every skill rank with
// its wording resolved) is a six-figure-byte JSON — uncompressed it was the
// slowest thing a phone on mobile data pulled from us. ~80% smaller wired.
app.use(compression());
app.use(express.json({ limit: "100kb" }));

// The console mounts ABOVE the global limiter on purpose. apiLimiter is 300 req
// / 15 min / IP across the entire API; a four-panel console would otherwise burn
// the lead dev's whole browsing budget and start 429-ing normal page loads from
// the same IP. Safe, because requireStaff — not the limiter — is the gate, and
// every console request still costs one user lookup inside resolveActor.
app.use("/api/console", consoleLimiter, consoleRoutes);

// Guild chat mounts above the global limiter for the console's reason in
// polling form: the chat pane refetches its guild's messages every 8s, which
// would burn the shared per-IP budget and start 429-ing the whole API for
// everyone on that household IP. Safe, because resolveActor plus the
// members-only gate inside every chat handler — not the limiter — is the
// wall. This router matches ONLY the /:id/messages paths (chatLimiter rides
// on those routes, inside the router, so unmatched /api/guilds requests fall
// through to the main guild mount below without touching the chat budget).
app.use("/api/guilds", guildChatRoutes);

// The guild-tag resolver mounts above the global limiter for the chat mount's
// reason in a wider form: the username chip asks "which guild is this person
// in" from nearly every page, so on the shared budget it would 429 the whole
// API for everyone behind that household IP. Safe, because this is a PUBLIC
// read of membership the guild page already shows, and the 100-id cap in the
// handler — not the limiter — is what bounds the work per request. This
// router matches ONLY POST /tags (tagLimiter rides on that route, inside the
// router, so unmatched /api/guilds requests fall through to the main guild
// mount below without touching the tag budget).
app.use("/api/guilds", guildTagsRoutes);

// Baseline rate limit on the whole API (auth routes get a stricter limiter of
// their own inside auth.routes.ts).
app.use("/api", apiLimiter);

// Basic health check. `features` names capabilities of THIS build — it exists
// because a code change with no externally visible surface (like the duel
// timeline recorder) is otherwise impossible to distinguish from the previous
// deploy, and "the service answers" says nothing about which build answered.
app.get("/health", (req, res) => {
  res.json({ status: "ok", features: ["duel-timeline", "lead-dev-free-shards", "wear-dust", "stat-truth", "wear-market", "support-truth", "lead-free-market", "pull-stats", "pull-stats-2", "pull-x8", "title-rack", "dust-all", "covenant-supports", "covenant-parity", "grant-all", "pull-x32", "gzip", "max-card", "ratings", "comment-reports", "polls", "post-permalink", "showcase-truth", "media-comments", "hidden-gems", "no-dungeon", "pulls-closed", "reset-refund", "raid-v1", "guilds-v1", "guild-raids", "co-leader", "guild-chat", "guild-banner", "guild-xp", "guild-roles", "guild-tags"] });
});

// Mount routers
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/anime", animeRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/torrent', torrentRoutes);
app.use('/api/subtitles', subtitleRoutes);
app.use('/api/users', userRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/likes", likesRoutes);
app.use("/api/comments", commentRoutes);
app.use("/api/ratings", ratingRoutes);
app.use("/api/polls", pollRoutes);
app.use("/api/gems", gemRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/system", systemRoutes);
app.use("/api/announcements", announcementRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/invites", inviteRoutes);
app.use("/api/novels", novelRoutes);
app.use("/api/manhwa-bookmarks", manhwaBookmarkRoutes);
app.use("/api/novel-bookmarks", novelBookmarkRoutes);
app.use("/api/kofi", kofiRoutes);
app.use("/api/raid", raidRoutes);
app.use("/api/guilds", guildRoutes);
app.use("/api/auctions", auctionRoutes);
app.use("/api/cards", cardRoutes);
app.use("/api/duels", duelRoutes);
app.use("/api/market", marketRoutes);

// Error Handler must be last
app.use(errorHandler);

export default app;
