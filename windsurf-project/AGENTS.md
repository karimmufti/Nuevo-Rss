# AGENTS.md — Project Context for AI Assistants

> This file provides context for AI coding assistants working on this project.

---

## Project Overview

**Live RSS News Terminal** — A real-time RSS news aggregator built incrementally to learn system design. Each version adds one infrastructure component.

**Target architecture:** RSS Feeds → Ingest Worker → Kafka → Indexer Worker → OpenSearch + Redis Cache → Express API (REST + WebSocket) → React Terminal UI

---

## V1 — The Simplest Pipeline ✅ (Completed)

**What was built:**
- Express server (`server/index.ts`) fetches BBC News RSS feed every 60 seconds
- RSS parsing (`server/rss.ts`) using `rss-parser` with custom User-Agent header
- In-memory article storage (`server/store.ts`) — plain array with Set-based deduplication
- Article type definition (`shared/types.ts`) — shared interface: id, title, link, publishedAt, source
- React frontend (`client/src/App.tsx`) with terminal-style UI (black bg, green text, orange source labels)
- Polling hook (`client/src/useArticles.ts`) — fetches GET /api/articles every 10 seconds
- Vite dev server for the client, Express on port 3001

**Key decisions made in V1:**
- Switched from Hacker News RSS to BBC News (`https://feeds.bbci.co.uk/news/rss.xml`) for faster update frequency (5-10 min vs 30+ min)
- Reddit RSS was attempted but returns 403 even with custom User-Agent — Reddit requires OAuth for reliable API access
- `rss-parser` configured with custom User-Agent header for compatibility
- Articles deduped by `id` field (RSS GUID or link fallback)
- ISO 8601 date strings used instead of Date objects for JSON serialization

**V1 limitations (being fixed in V2):**
- Articles lost on server restart (no persistence)
- Deduplication is in-process only (manual Set check in JS)
- No caching — every GET /api/articles call re-sorts the entire array

**Tech stack (V1):**
- Server: Express, rss-parser, TypeScript, tsx (watch mode)
- Client: React 19, Vite 6, TypeScript
- No database, no cache, no message queue

---

## V2 — Add Redis for Caching + Deduplication ✅ (Completed)

**What was built:**
- Redis replaces the in-memory array for persistent article storage
- Sorted set (`articles:timeline`) stores article IDs ordered by publish timestamp
- Hashes (`articles:data:<id>`) store full article data per article
- Deduplication via `ZADD NX` — Redis rejects duplicate sorted set members automatically
- Pipelined commands — all Redis ops batched into single network round-trips
- Articles survive server restarts (Redis persists to disk)

**Files modified/created:**
- `server/redis.ts` — **new**: Redis client connection with ioredis, event listeners
- `server/store.ts` — **rewritten**: array → Redis sorted set + hashes, sync → async
- `server/index.ts` — **updated**: route handler now async with try/catch for Redis errors
- `package.json` — added `ioredis` dependency

**Key decisions made in V2:**
- Used sorted set + hashes (not JSON strings in sorted set) for structured field access
- Used `ZADD NX` for deduplication instead of checking existence first
- Pipeline batching for all multi-command operations
- `maxRetriesPerRequest: null` on Redis client for resilience

**V2 limitations (being fixed in V3):**
- RSS fetching and API serving are coupled in one process
- No buffering if the API server restarts — RSS data is missed
- Can't scale fetching and serving independently

**Tech stack (V2):**
- Server: Express, rss-parser, ioredis, TypeScript, tsx
- Client: React 19, Vite 6, TypeScript (unchanged from V1)
- Infrastructure: Redis on localhost:6379

---

## V3 — Add Kafka (Redpanda) for Decoupling ✅ (Completed)

**What was built:**
- Redpanda (Kafka-compatible broker) decouples RSS ingestion from the API server
- Ingest Worker (`server/ingest.ts`): separate process that fetches RSS and publishes articles to Kafka
- Kafka Consumer (`server/consumer.ts`): reads from topic, stores articles in Redis
- API Server (`server/index.ts`): starts consumer + serves REST API (no longer fetches RSS)
- Shared Kafka config (`server/kafka.ts`): single source of truth for broker address + topic name
- RSS module (`server/rss.ts`): now pure — just fetches and returns articles, no side effects
- Two independent processes instead of one monolithic server

**Files modified/created:**
- `server/kafka.ts` — **new**: shared Kafka client (kafkajs), broker config, topic name constant
- `server/ingest.ts` — **new**: standalone RSS ingest worker (Kafka producer with 60s loop)
- `server/consumer.ts` — **new**: Kafka consumer with `eachMessage` handler, stores in Redis
- `server/rss.ts` — **modified**: renamed `fetchAndStore()` → `fetchArticles()`, returns articles instead of writing to store
- `server/index.ts` — **modified**: removed RSS polling, starts Kafka consumer on boot, graceful shutdown
- `package.json` — added `kafkajs` dependency, added `npm run ingest` script

**Key decisions made in V3:**
- Used Redpanda (not Apache Kafka) — simpler local setup, no Java/Zookeeper, Kafka-compatible API
- Redpanda runs in Docker: single-broker, `localhost:9092`
- One topic (`"articles"`), one partition, one consumer group (`"api-server"`)
- Consumer subscribes with `fromBeginning: false` — only processes new messages
- `rss.ts` made pure (no side effects) — the V3 decoupling boundary
- Ingest worker uses `while(true)` + `setTimeout` instead of `setInterval` for sequential cycles
- Graceful shutdown on both processes (SIGINT/SIGTERM → disconnect producer/consumer)

**V3 limitations (being fixed in V4):**
- No search capability — can only browse articles chronologically
- No way to find articles by keyword, topic, or content
- Redis stores articles but can't do full-text search efficiently

**Tech stack (V3):**
- Server: Express, rss-parser, ioredis, kafkajs, TypeScript, tsx
- Client: React 19, Vite 6, TypeScript (unchanged)
- Infrastructure: Redis on localhost:6379, Redpanda (Docker) on localhost:9092

---

## V4 — Add OpenSearch for Full-Text Search ✅ (Completed)

**What was built:**
- OpenSearch (full-text search engine) enables keyword search across article titles
- Dual-write pattern: consumer writes each article to both Redis (timeline) and OpenSearch (search)
- `server/opensearch.ts`: OpenSearch client, index creation, indexing, and search functions
- `GET /api/search?q=` endpoint for full-text search
- React search bar with 300ms debouncing, browse mode vs search mode
- `useSearch()` hook for on-demand search queries

**Files modified/created:**
- `server/opensearch.ts` — **new**: OpenSearch client, ensureIndex(), indexArticle(), searchArticles()
- `server/consumer.ts` — **modified**: dual-write with Promise.all (Redis + OpenSearch)
- `server/index.ts` — **modified**: added `GET /api/search?q=` endpoint, ensureIndex() on startup
- `client/src/App.tsx` — **modified**: search bar with debounce, browse vs search mode toggle
- `client/src/useArticles.ts` — **modified**: added `useSearch()` hook
- `package.json` — added `@opensearch-project/opensearch` dependency

**Key decisions made in V4:**
- Dual-write pattern: Redis for chronological browsing, OpenSearch for keyword search
- OpenSearch index mapping: `title` as `text` (tokenized), `id`/`link`/`source` as `keyword` (exact), `publishedAt` as `date`
- `multi_match` query with `fuzziness: "AUTO"` for typo tolerance
- Article ID used as OpenSearch document ID — re-indexing is idempotent
- Promise.all for parallel writes to Redis + OpenSearch
- 300ms debounce on search input to avoid hammering the API
- RSS feed switched to Lorem RSS (`https://lorem-rss.herokuapp.com/feed?unit=second&interval=10&length=20`) for faster testing
- Ingest worker polling interval reduced to 15s to match the fast feed

**V4 limitations (being fixed in V5):**
- Frontend polls every 10 seconds — not truly real-time
- Newly ingested articles don’t appear instantly in the UI
- Polling wastes bandwidth when nothing has changed

**Tech stack (V4):**
- Server: Express, rss-parser, ioredis, kafkajs, @opensearch-project/opensearch, TypeScript, tsx
- Client: React 19, Vite 6, TypeScript
- Infrastructure: Redis on localhost:6379, Redpanda (Docker) on localhost:9092, OpenSearch (Docker) on localhost:9200

---

## V5 — Add WebSocket for Real-Time Push ✅ (Completed)

**What was built:**
- WebSocket server (`server/websocket.ts`) pushes new articles to connected clients instantly
- No more polling — articles appear the moment they're consumed from Kafka
- Consumer triple-writes: Redis (timeline) + OpenSearch (search) + WebSocket (push)
- Auto-reconnecting WebSocket client with connection status indicator (LIVE/OFFLINE)
- Multi-feed ingestion: 79 real RSS feeds fetched in parallel via `Promise.allSettled()`
- Feed config (`server/feeds.ts`): centralized array of feed URLs + source names
- UI enhancements: pagination (Load More), auto-updating timestamps, ESC to clear search, skeleton loading, refresh button

**Files modified/created:**
- `server/websocket.ts` — **new**: WebSocket server, attachWebSocket(), broadcast()
- `server/feeds.ts` — **new**: 79 RSS feed configs (BBC, NYT, Guardian, TechCrunch, etc.)
- `server/consumer.ts` — **modified**: added broadcast() call after dual-write (triple-write)
- `server/index.ts` — **modified**: captures HTTP server from app.listen(), attaches WebSocket
- `server/rss.ts` — **rewritten**: fetchFeed() for single feed, fetchAllFeeds() for parallel multi-feed
- `server/ingest.ts` — **modified**: uses fetchAllFeeds(), 60s poll interval for 79 feeds
- `server/store.ts` — **modified**: getArticles() now paginated (page, limit, hasMore, total)
- `server/opensearch.ts` — **modified**: searchArticles() now paginated (from, size, total, hasMore)
- `client/src/useArticles.ts` — **rewritten**: WebSocket for real-time push, REST for initial load + Load More
- `client/src/App.tsx` — **modified**: Load More button, ESC shortcut, skeleton loading, refresh button, LIVE/OFFLINE indicator
- `client/src/terminal.css` — **modified**: skeleton shimmer, load-more/refresh button styles, offline dot
- `package.json` — added `ws` and `@types/ws` dependencies

**Key decisions made in V5:**
- WebSocket shares the same port (3001) as Express — `ws` library handles upgrade requests
- WebSocket broadcast happens AFTER storage (Redis + OpenSearch) so clients only see persisted articles
- Auto-reconnect with 3s delay on disconnect — resilient to server restarts
- REST API still used for initial page load and "Load More" — WebSocket only for real-time push
- `Promise.allSettled()` for multi-feed fetching — one failing feed doesn't block others
- 10s timeout per feed to prevent slow feeds from stalling the cycle
- RSS guid coerced to string — some feeds return guid as object, which crashed Kafka partitioner
- Removed Lorem RSS test feed — now using 79 real news sources
- Client-side sort by `publishedAt` after every merge to prevent old articles floating to top

**V5 limitations (being fixed in V6):**
- No observability (metrics, health checks, structured logging)
- Shared Article type module now lives in `shared/types.ts` and is imported by both server and client
- No benchmarks or load testing

**Tech stack (V5):**
- Server: Express, ws, rss-parser, ioredis, kafkajs, @opensearch-project/opensearch, TypeScript, tsx
- Client: React 19, Vite 6, TypeScript
- Infrastructure: Redis on localhost:6379, Redpanda (Docker) on localhost:9092, OpenSearch (Docker) on localhost:9200

---

## V6 — Add ClickHouse for Permanent Storage ✅ (Completed)

**What was built:**
- ClickHouse (column-oriented OLAP database) stores ALL articles permanently (billions scale)
- Redis demoted from source of truth to cache — capped at 1,000 most recent articles
- Smart routing: API auto-routes to Redis (pages 1-20) or ClickHouse (pages 21+)
- Consumer quad-writes: ClickHouse (permanent) + Redis (cache) + OpenSearch (search) + WebSocket (push)
- Numbered pagination (50 articles/page) replaces "Load More"
- Page 1 gets real-time WebSocket push; archive pages fetched on demand from ClickHouse

**Files modified/created:**
- `server/clickhouse.ts` — **new**: ClickHouse client, ensureTable(), insertArticle(), getArchivePage(), getTotalArticles()
- `server/store.ts` — **modified**: added REDIS_MAX_ARTICLES cap (1,000), ZREMRANGEBYRANK eviction
- `server/consumer.ts` — **modified**: quad-write (ClickHouse + Redis + OpenSearch + WebSocket)
- `server/index.ts` — **modified**: smart routing in GET /api/articles, ensureTable() on startup
- `client/src/useArticles.ts` — **rewritten**: numbered pagination (goToPage), WebSocket only on page 1
- `client/src/App.tsx` — **modified**: numbered pagination UI (« ‹ 1 2 3 … N › »), version badge v6
- `client/src/terminal.css` — **modified**: pagination button styles
- `package.json` — added `@clickhouse/client` dependency

**Key decisions made in V6:**
- ClickHouse with ReplacingMergeTree engine — deduplicates on (published_at, id) during background merges
- Redis capped at 1,000 articles via ZREMRANGEBYRANK — oldest evicted after each insert
- Smart routing: offset < 1,000 → Redis (sub-millisecond), offset >= 1,000 → ClickHouse (low-latency)
- Total article count comes from ClickHouse (true total), not Redis (capped at 1,000)
- Page size increased to 50 (from 20) for archive browsing
- WebSocket only inserts on page 1 — archive pages are static (fetched on demand)
- ClickHouse runs in Docker on ports 8123 (HTTP) and 9000 (native)

**V6 architecture:**
```
Kafka Consumer → ClickHouse (ALL articles, permanent — billions scale)
              → Redis (last 1,000 — cache for live feed)
              → OpenSearch (search index)
              → WebSocket (real-time push to page 1)

Frontend (pages 1-20) → API → Redis (fast)
Frontend (pages 21+)  → API → ClickHouse (archive)
Frontend (search)     → API → OpenSearch
```

**Tech stack (V6):**
- Server: Express, ws, rss-parser, ioredis, kafkajs, @opensearch-project/opensearch, @clickhouse/client, TypeScript, tsx
- Client: React 19, Vite 6, TypeScript
- Infrastructure: Redis localhost:6379, Redpanda (Docker) localhost:9092, OpenSearch (Docker) localhost:9200, ClickHouse (Docker) localhost:8123/9000

---

## Coding Conventions

1. **Every file has a 3-6 line comment block at the top** explaining WHAT, WHY, and HOW
2. **Every non-obvious line has an inline comment** — this is a learning project
3. **Minimal dependencies** — only add what's needed for the current version
4. **No skipping ahead** — don't add infrastructure for future versions
5. **Source of truth for types:** `shared/types.ts` (server and client both import from here)

## Running the Project

```bash
# Start Redpanda (Kafka broker, one-time)
docker run -d --name redpanda -p 9092:9092 docker.redpanda.com/redpandadata/redpanda:latest redpanda start --overprovisioned --smp 1 --memory 256M --reserve-memory 0M --node-id 0 --check=false --kafka-addr 0.0.0.0:9092 --advertise-kafka-addr 127.0.0.1:9092

# Start OpenSearch (search engine, one-time)
docker run -d --name opensearch -p 9200:9200 -e "discovery.type=single-node" -e "DISABLE_SECURITY_PLUGIN=true" opensearchproject/opensearch:2.11.0

# Start ClickHouse (permanent storage, one-time)
docker run -d --name clickhouse -p 8123:8123 -p 9000:9000 --ulimit nofile=262144:262144 -e CLICKHOUSE_USER=rss_app -e CLICKHOUSE_PASSWORD=rss_app_password clickhouse/clickhouse-server:latest

# Terminal 1: API Server (consumes from Kafka, quad-writes to ClickHouse + Redis + OpenSearch + WebSocket)
npm run dev

# Terminal 2: Ingest Worker (fetches RSS, publishes to Kafka)
npm run ingest

# Terminal 3: Client (from client/ directory)
cd client && npm run dev

# Kill stuck port
lsof -ti :3001 | xargs kill -9
```
