# Da Vinci Tracker Backend

A robust Express.js backend designed to act as an Anime metadata and status tracking proxy. This backend leverages the **AniList GraphQL API** to fetch data, caches it to prevent rate limits, and provides a clean REST API for frontends.

> **⚠️ IMPORTANT DISCLAIMER**
> This is strictly an educational tracking and metadata backend. **It does not scrape streaming websites, nor does it host or link to any copyrighted video content.** It only interacts with the official public AniList API to retrieve metadata (titles, descriptions, cover images, release dates).

## Tech Stack
- **Node.js + Express** (REST API)
- **TypeScript** (Strong typing)
- **Prisma** (Database ORM - configured for SQLite locally, easy upgrade to PostgreSQL)
- **Zod** (Query and Payload validation)
- **Axios** (GraphQL requests)

## Core Features
1. **AniList GraphQL Proxy**: Safely requests data from AniList without exposing complex GraphQL logic to the frontend.
2. **Caching Layer**: Stores AniList query results in the local database based on TTLs (e.g., Dashboard 15m, Search 10m).
3. **Local Auth & Watchlist**: Manages local User and Watchlist tables to track anime progress without requiring a third-party login.

---

## Getting Started

### 1. Installation
Clone the repository and install dependencies:
```bash
npm install
```

### 2. Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Ensure `FRONTEND_URL` matches your frontend origin for CORS.

### 3. Database Setup
Initialize the SQLite database and generate the Prisma Client:
```bash
npm run prisma:migrate
npm run prisma:generate
```

### 4. Running the Server
Start the development server with auto-reload:
```bash
npm run dev
```
The server will be available at `http://localhost:5000`.

---

## API Documentation

### Anime & Discovery
- `GET /api/dashboard` - Get aggregated dashboard (Trending, Airing, Upcoming, etc.)
- `GET /api/anime/:id` - Get detailed anime info by AniList ID
- `GET /api/anime/status/:status` - Get anime by status (RELEASING, FINISHED, UPCOMING)
- `GET /api/search?q=Naruto&status=RELEASING` - Search with optional filters

### Schedule / Calendar
- `GET /api/calendar` - Get the next 7 days of airing anime
- `GET /api/calendar/today` - Get anime airing strictly today

### Users & Watchlist (Local DB)
- `POST /api/users` - Create a new user (`{ username, email }`)
- `GET /api/users/:id` - Get user and their watchlist
- `POST /api/watchlist` - Add anime to watchlist
- `PATCH /api/watchlist/:id` - Update status/score/notes
- `DELETE /api/watchlist/:id` - Remove from watchlist

---

## Deployment Notes

To deploy to modern hosting platforms (Render, Railway, Vercel, Fly.io):

1. **Database Update**: SQLite is ephemeral on platforms like Render. Change the Prisma `provider` to `"postgresql"` in `schema.prisma` and provide a Postgres `DATABASE_URL`.
2. **Start Command**: Set the start command to `npm run build && npm start`.
3. **Environment**: Add `NODE_ENV=production` and `FRONTEND_URL` to your production host variables.
