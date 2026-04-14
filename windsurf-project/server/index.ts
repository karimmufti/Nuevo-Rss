/**
 * WHAT: Express API server entry point — HTTP + WebSocket server, Kafka consumer, ClickHouse, OpenSearch.
 * WHY:  This is the "brain" of V6. It does five things:
 *       1. Consumes articles from Kafka and quad-writes to ClickHouse + Redis + OpenSearch + WebSocket
 *       2. Serves GET /api/articles — auto-routes to Redis (recent) or ClickHouse (archive)
 *       3. Serves GET /api/search?q= — full-text search from OpenSearch
 *       4. Pushes new articles to connected clients via WebSocket
 *       5. ClickHouse = source of truth (all articles), Redis = cache (last 1,000)
 * HOW:  1. Creates an Express app with CORS enabled.
 *       2. Defines GET /api/articles (smart routing) and GET /api/search?q=.
 *       3. Ensures ClickHouse table + OpenSearch index exist, then starts the Kafka consumer.
 *       4. Attaches a WebSocket server to the HTTP server (same port 3001).
 *
 * V6 CHANGE: Added ClickHouse as permanent store. Redis capped at 1,000. Smart routing.
 */

// Express is a minimal web framework for Node.js. It handles HTTP requests and routing.
// Think of it as a switchboard: when a request comes in, Express routes it to the right handler.
import express from "express";

// CORS (Cross-Origin Resource Sharing) is a browser security feature.
// Our React client runs on localhost:5173 but the API is on localhost:3001.
// Without CORS, the browser would block the client from making requests to a different port.
// This middleware tells the browser "it's okay, allow requests from other origins."
import cors from "cors";

// Import the Kafka consumer functions. The consumer reads articles from the Kafka topic
// (published by the ingest worker) and stores them in Redis.
import { startConsumer, stopConsumer } from "./consumer.js";

// Import the store's getter — this retrieves all articles sorted newest-first from Redis.
import { getArticles } from "./store.js";

// V4: Import OpenSearch functions for full-text search.
// ensureIndex creates the "articles" index on startup if it doesn't exist.
// searchArticles queries OpenSearch for articles matching a keyword.
import { ensureIndex, searchArticles } from "./opensearch.js";

// V5: Import WebSocket server. attachWebSocket() binds to the HTTP server so
// WebSocket and Express share the same port (3001). No extra port needed.
import { attachWebSocket } from "./websocket.js";

// V6: Import ClickHouse functions. ClickHouse is the permanent source of truth.
// ensureTable creates the articles table on startup. getArchivePage reads paginated history.
// getTotalArticles returns the true total count across all articles (not just Redis cache).
import { ensureTable, getArchivePage, getTotalArticles } from "./clickhouse.js";

// --- App Setup ---

// Create the Express application instance. Everything hangs off this object.
const app = express();

// The port our server listens on. 3001 is a common choice for API servers during development
// because it avoids conflicts with common frontend dev servers (3000, 5173, etc.).
const PORT = 3001;

// --- Middleware ---

// Allow any localhost origin — Vite sometimes picks a different port (5174, 5175...)
// when the default is already in use. Restricting to a specific port would randomly
// break the UI every time that happens. We still block all non-localhost origins.
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, server-to-server).
    if (!origin) return callback(null, true);
    // Allow any localhost or 127.0.0.1 port.
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: blocked origin ${origin}`));
  },
}));

// express.json() parses incoming JSON request bodies. We don't need it in V4
// (we only have GET endpoints), but it's standard practice to include it
// so the server is ready if we add POST endpoints later.
app.use(express.json());

// --- Routes ---

// GET /api/articles?page=1&limit=50 — Paginated article browsing.
// V6: Smart routing — serves from Redis (cache) for recent pages, falls back to
// ClickHouse (permanent store) for archive pages beyond what Redis holds.
//
// Redis holds the last 1,000 articles. At 50/page, that's pages 1–20.
// Pages 21+ are served from ClickHouse (billions of articles, still fast).
// The frontend doesn't know which backend is serving — it just requests a page.
//
// Query params:
//   page  — 1-indexed page number (default: 1)
//   limit — articles per page (default: 50, max: 100)
app.get("/api/articles", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));

    // Get the true total from ClickHouse (not Redis, which is capped at 1,000).
    const totalArticles = await getTotalArticles();

    // Check if Redis can serve this page.
    // Redis has the newest 1,000 articles. If the requested offset is within that range,
    // serve from Redis (fastest). Otherwise, fall back to ClickHouse.
    const offset = (page - 1) * limit;
    const REDIS_CAP = 1_000;

    if (offset < REDIS_CAP) {
      // Serve from Redis — fast path for recent pages.
      const result = await getArticles(page, limit);
      // Override total with ClickHouse's true total (Redis only knows about its 1,000).
      res.json({ ...result, total: totalArticles, hasMore: (page * limit) < totalArticles });
    } else {
      // Serve from ClickHouse — archive path for older pages.
      const result = await getArchivePage(page, limit);
      res.json({ ...result, total: totalArticles });
    }
  } catch (error) {
    console.error("[server] Failed to fetch articles:", error);
    res.status(500).json({ error: "Failed to fetch articles" });
  }
});

// --- V4: Search Endpoint ---

// GET /api/search?q=<query> — Full-text search powered by OpenSearch.
// This is the V4 addition. Unlike /api/articles (which returns ALL articles sorted by time),
// this endpoint returns only articles matching the search query, sorted by relevance.
//
// How it works under the hood:
// 1. User types "lorem" in the search bar
// 2. React calls GET /api/search?q=lorem
// 3. Express passes "lorem" to OpenSearch's multi_match query
// 4. OpenSearch looks up "lorem" in its inverted index → finds matching document IDs
// 5. OpenSearch scores and ranks the matches → returns top 50
// 6. Express sends the results as JSON to the frontend
app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q as string;

    if (!q || q.trim().length === 0) {
      res.json({ articles: [], total: 0, page: 1, limit: 20, hasMore: false });
      return;
    }

    // Parse pagination params — search results are paginated too.
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

    // searchArticles now returns paginated results.
    const results = await searchArticles(q.trim(), page, limit);
    res.json(results);
  } catch (error) {
    console.error("[server] Search failed:", error);
    res.status(500).json({ error: "Search failed" });
  }
});

// --- Server Start ---

// app.listen() starts the HTTP server on the specified port.
// The callback runs once the server is ready to accept connections.
// app.listen() returns the raw Node.js HTTP server. We capture it so we can
// attach the WebSocket server to it (same port, no conflicts with Express).
const server = app.listen(PORT, async () => {
  console.log(`[server] RSS News Terminal API running on http://localhost:${PORT}`);
  console.log(`[server] Try it: http://localhost:${PORT}/api/articles`);

  // --- V5: Attach WebSocket Server ---
  // The ws library detects WebSocket upgrade requests on the same HTTP server.
  // Clients connect to ws://localhost:3001 and receive real-time article pushes.
  attachWebSocket(server);

  // --- V6: Initialize ClickHouse Table ---
  try {
    await ensureTable();
    console.log("[server] ClickHouse table ready.");
  } catch (error) {
    console.error("[server] Failed to initialize ClickHouse table:", error);
    console.error("[server] Make sure ClickHouse is running: docker ps | grep clickhouse");
    process.exit(1);
  }

  // --- V4: Initialize OpenSearch Index ---
  try {
    await ensureIndex();
    console.log("[server] OpenSearch index ready.");
  } catch (error) {
    console.error("[server] Failed to initialize OpenSearch index:", error);
    console.error("[server] Make sure OpenSearch is running: docker ps | grep opensearch");
    process.exit(1);
  }

  // --- V3: Start Kafka Consumer ---
  // In V6, each message is quad-written to ClickHouse + Redis + OpenSearch + WebSocket.
  try {
    await startConsumer();
    console.log("[server] Kafka consumer started. Listening for articles...");
  } catch (error) {
    console.error("[server] Failed to start Kafka consumer:", error);
    console.error("[server] Make sure Redpanda is running: docker ps | grep redpanda");
    process.exit(1);
  }
});

// --- Graceful Shutdown ---

// Listen for SIGINT (Ctrl+C) and SIGTERM (docker stop, kill command) signals.
// When the server is being killed, we disconnect the Kafka consumer cleanly.
// This ensures the consumer commits its offsets (tells Kafka where it stopped reading)
// before shutting down. Without this, Kafka might re-deliver messages on restart.
process.on("SIGINT", async () => {
  console.log("\n[server] Received SIGINT, shutting down gracefully...");
  await stopConsumer();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[server] Received SIGTERM, shutting down gracefully...");
  await stopConsumer();
  process.exit(0);
});
