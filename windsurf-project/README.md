# 🖥️ Live RSS News Terminal

> **Current Version: V6** — ClickHouse for Permanent Storage ✅

A real-time RSS news aggregator built incrementally from scratch to learn system design concepts one layer at a time. Each version adds exactly one new infrastructure component so you deeply understand what it does, why it exists, and how it connects to everything else.

---

## Current Architecture (V6)

**Live:** Redis cache (last 1,000 articles) + WebSocket real-time push + numbered pagination
**Archive:** ClickHouse permanent storage (billions of articles) + smart routing
**Search:** OpenSearch full-text search
**Decoupled:** Kafka (Redpanda) message queue

```
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│  RSS Feeds  │───▶│  Ingest Worker   │───▶│   Redpanda   │
│  (79 feeds) │    │  (fetches RSS)   │    │   (Kafka)    │
└─────────────┘    └──────────────────┘    └──────┬──────┘
                                                  │
                                                  ▼
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│   React     │◀──▶│   Express API    │◀──▶│  ClickHouse  │
│  Terminal   │    │  (REST + WS)     │    │ (permanent)  │
│     UI      │    └────────┬─────────┘    └─────────────┘
└─────────────┘             │
                            ▼
                    ┌──────────────┐    ┌──────────────┐
                    │  Redis Cache │    │  OpenSearch  │
                    │ (last 1,000)  │    │ (full-text)  │
                    └──────────────┘    └──────────────┘
```

---

## V1 Architecture (Completed ✅)

The foundation. Simple. No extras. Just the core data pipeline.

```
┌─────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  BBC News   │───▶│  Express Server  │───▶│  In-Memory      │
│  RSS (1     │    │  (fetches every  │    │  Array (store)  │
│   feed)     │    │   60 seconds)    │    │                 │
└─────────────┘    └────────┬─────────┘    └─────────────────┘
                            │
                   GET /api/articles
                            │
                            ▼
                   ┌─────────────────┐
                   │  React Frontend │
                   │  (polls every   │
                   │   10 seconds)   │
                   └─────────────────┘
```

**V1 Data flow:** Server fetches RSS → stores in array → React polls REST endpoint → displays articles.

**V1 Limitations (fixed in V2):**
- Articles lost on server restart (no persistence)
- Deduplication is manual (Set-based check in JS)
- No caching layer — every API request rebuilds the sorted array

---

## V2 Architecture (Completed ✅)

Added Redis as a persistent cache and deduplication layer.

```
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│  BBC News   │───▶│  Express Server  │───▶│    Redis     │
│  RSS (1     │    │  (fetches every  │    │  (cache +   │
│   feed)     │    │   60 seconds)    │    │   dedup)    │
└─────────────┘    └────────┬─────────┘    └─────────────┘
                            │
                   GET /api/articles
                            │
                            ▼
                   ┌─────────────────┐
                   │  React Frontend │
                   │  (polls every   │
                   │   10 seconds)   │
                   └─────────────────┘
```

**V2 Data flow:** Server fetches RSS → stores in Redis (dedup by article ID) → React polls REST endpoint → Express reads from Redis → displays articles.

**V2 Limitations (fixed in V3):**
- RSS fetching and API serving are coupled in one process — if the server crashes, both stop
- No way to buffer incoming articles while the API is restarting
- Can’t scale fetching and serving independently

---

## V3 Architecture (Completed ✅)

Decoupled RSS ingestion from the API server using Kafka (Redpanda). Two independent processes.

```
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│  BBC News   │───▶│  Ingest Worker  │───▶│   Redpanda   │
│  RSS        │    │  (fetches RSS,  │    │   (Kafka)    │
│             │    │   publishes)    │    │             │
└─────────────┘    └──────────────────┘    └─────┬───────┘
                                                  │
                                                  ▼
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│  React      │◀───│  Express API    │◀───│    Redis     │
│  Frontend   │    │  (consumes from │    │  (cache +   │
│             │    │   Kafka + serves│    │   dedup)    │
└─────────────┘    └──────────────────┘    └─────────────┘
```

**V3 Data flow:** Ingest Worker fetches RSS → publishes articles to Kafka topic → API server consumes from Kafka → stores in Redis → React polls REST endpoint → displays articles.

---

## V4 Architecture (Completed ✅)

Added OpenSearch for full-text search. Dual-write pattern: consumer writes to both Redis and OpenSearch.

```
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│ 79 RSS      │───▶│  Ingest Worker  │───▶│   Redpanda   │
│  feeds      │    │  (fetches RSS,  │    │   (Kafka)    │
└─────────────┘    │   publishes)    │    └──────┬──────┘
                    └──────────────────┘           │
                                                 │ consume
                                                 ▼
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│  React      │◀───│  Express API    │◀───│    Redis     │ (timeline)
│  Frontend   │    │  /api/articles  │    └─────────────┘
│  + search   │    │  /api/search    │    ┌─────────────┐
└─────────────┘    └──────────────────┘◀───│  OpenSearch  │ (search)
                                           └─────────────┘
```

**V4 Data flow:** Consumer reads from Kafka → dual-writes to Redis (sorted timeline) + OpenSearch (full-text index) → `/api/articles` reads from Redis → `/api/search?q=` reads from OpenSearch → React shows either timeline or search results.

---

## V5 Architecture (Completed ✅)

Added WebSocket for real-time push. Replaced polling with instant updates.

```
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│ 79 RSS      │───▶│  Ingest Worker  │───▶│   Redpanda   │
│  feeds      │    │  (fetches RSS,  │    │   (Kafka)    │
└─────────────┘    │   publishes)    │    └──────┬──────┘
                    └──────────────────┘           │
                                                 │ consume
                                                 ▼
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│  React      │◀───│  Express API    │◀───│    Redis     │ (timeline)
│  Frontend   │    │  /api/articles  │    └─────────────┘
│  + search   │    │  /api/search    │    ┌─────────────┐
│  + WS       │    │  WebSocket      │◀───│  OpenSearch  │ (search)
└─────────────┘    └──────────────────┘    └─────────────┘
```

**V5 Data flow:** Consumer reads from Kafka → dual-writes to Redis + OpenSearch → broadcasts new articles via WebSocket → React receives instant updates on page 1.

---

## V6 Architecture (Completed ✅)

Added ClickHouse as permanent storage. Redis became a cache (capped at 1,000). Smart routing + numbered pagination.

```
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│ 79 RSS      │───▶│  Ingest Worker  │───▶│   Redpanda   │
│  feeds      │    │  (fetches RSS,  │    │   (Kafka)    │
└─────────────┘    │   publishes)    │    └──────┬──────┘
                    └──────────────────┘           │
                                                 │ quad-write
                                                 ▼
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│  React      │◀───│  Express API    │◀───│  ClickHouse  │ (ALL articles)
│  Frontend   │    │  smart routing   │    │  (permanent) │
│  + search   │    │  (Redis/CH)      │    └─────────────┘
│  + WS       │    │  WebSocket       │    ┌─────────────┐
│  + pages    │    └────────┬─────────┘    │  Redis Cache │ (last 1,000)
└─────────────┘             │              └─────────────┘
                            ▼                    ┌─────────────┐
                    ┌──────────────┐            │  OpenSearch  │ (search)
                    │  OpenSearch  │            └─────────────┘
                    └──────────────┘
```

**V6 Data flow:** Consumer quad-writes to ClickHouse + Redis + OpenSearch + WebSocket. API auto-routes: pages 1-20 → Redis (cache), pages 21+ → ClickHouse (archive). Frontend shows numbered pagination (50/page).

---

## Version Milestones

Each version teaches a specific system design concept. We don't skip ahead.

### V1 — The Simplest Pipeline ✅ *(completed)*
**What:** Express fetches BBC News RSS on a timer, stores in an in-memory array, serves via REST. React polls and displays.
**Why:** Learned the basic request-response model, data flow from external source to UI, and polling as the simplest form of "live" updates.
**Key files:** `server/index.ts`, `server/rss.ts`, `server/store.ts`, `client/src/useArticles.ts`, `client/src/App.tsx`

### V2 — Add Redis for Caching + Deduplication ✅ *(completed)*
**What:** Replaced in-memory array with Redis sorted set + hashes. Deduplication via ZADD NX.
**Why:** Learned persistence, key-value stores, sorted sets, pipelining, and async I/O.
**Key files:** `server/redis.ts` (new), `server/store.ts` (rewritten), `server/index.ts` (async handler)

### V3 — Add Kafka (Redpanda) for Decoupling ✅ *(completed)*
**What:** Split into ingest worker (producer) and API server (consumer), communicating via Redpanda (Kafka-compatible broker).
**Why:** Learned message queues, producer-consumer pattern, event-driven architecture, Kafka offsets, consumer groups, and service decoupling.
**Key files:** `server/kafka.ts` (new), `server/ingest.ts` (new), `server/consumer.ts` (new), `server/rss.ts` (modified), `server/index.ts` (modified)

### V4 — Add OpenSearch for Full-Text Search ✅ *(completed)*
**What:** Dual-write articles to Redis + OpenSearch. Added `GET /api/search?q=` and a search bar in the UI.
**Why:** Learned inverted indexes, full-text search vs exact match, dual-write pattern, index mappings, and OpenSearch query DSL.
**Key files:** `server/opensearch.ts` (new), `server/consumer.ts` (dual-write), `server/index.ts` (search endpoint), `client/src/App.tsx` (search bar), `client/src/useArticles.ts` (useSearch hook)

### V5 — Add WebSocket for Live Updates ✅ *(completed)*
**What:** Replace polling with WebSocket so the frontend gets articles pushed in real-time.
**Why:** Learn the difference between polling and push, when WebSocket is better than HTTP, and how to manage persistent connections.
**Key files:** `server/websocket.ts` (new), `server/consumer.ts` (broadcast), `client/src/useArticles.ts` (WebSocket), `client/src/App.tsx` (LIVE/OFFLINE)

### V6 — Add ClickHouse for Permanent Storage ✅ *(completed)*
**What:** ClickHouse stores ALL articles permanently (billions scale). Redis becomes a cache (last 1,000). Smart routing + numbered pagination.
**Why:** Learn column-oriented databases, cache vs source-of-truth patterns, smart routing, and scaling to billions of rows.
**Key files:** `server/clickhouse.ts` (new), `server/store.ts` (capped cache), `server/consumer.ts` (quad-write), `server/index.ts` (smart routing), `client/src/useArticles.ts` (numbered pages), `client/src/App.tsx` (pagination UI)

---

## Setup & Run (V6)

### Prerequisites
- Node.js 18+
- npm
- Redis (`brew install redis && brew services start redis`)
- Docker (for Redpanda + OpenSearch + ClickHouse)

### Start Docker Containers (one-time)

```bash
# Redpanda (Kafka broker)
docker run -d --name redpanda -p 9092:9092 docker.redpanda.com/redpandadata/redpanda:latest redpanda start --overprovisioned --smp 1 --memory 256M --reserve-memory 0M --node-id 0 --check=false --kafka-addr 0.0.0.0:9092 --advertise-kafka-addr 127.0.0.1:9092

# OpenSearch (search engine)
docker run -d --name opensearch -p 9200:9200 -e "discovery.type=single-node" -e "DISABLE_SECURITY_PLUGIN=true" opensearchproject/opensearch:2.11.0

# ClickHouse (permanent storage)
docker run -d --name clickhouse -p 8123:8123 -p 9000:9000 --ulimit nofile=262144:262144 -e CLICKHOUSE_USER=rss_app -e CLICKHOUSE_PASSWORD=rss_app_password clickhouse/clickhouse-server:latest
```

### Install & Start (3 terminals)

```bash
# Terminal 1: API Server (consumes from Kafka, quad-writes to ClickHouse + Redis + OpenSearch + WebSocket)
npm install
npm run dev

# Terminal 2: Ingest Worker (fetches 79 RSS feeds, publishes to Kafka)
npm run ingest

# Terminal 3: React Client
cd client && npm install && npm run dev
```

### Verify It Works

1. Open `http://localhost:5173` in your browser
2. You should see a terminal-style UI with numbered pagination (50 articles/page)
3. Page 1 shows LIVE indicator and gets real-time updates via WebSocket
4. Click page numbers to browse archive — pages 21+ are served from ClickHouse
5. Use the search bar to search articles via OpenSearch
6. Check Terminal 1 logs for quad-write: `[consumer] Received article from Kafka` + `[store] Added...` + `[clickhouse]`

---

## Project Structure (V6)

```
windsurf-project/
├── server/
│   ├── index.ts       # Express API server — smart routing (Redis/ClickHouse) + WebSocket (V6)
│   ├── ingest.ts      # Ingest Worker — fetches 79 RSS feeds, publishes to Kafka (V5)
│   ├── consumer.ts    # Kafka Consumer — quad-writes to ClickHouse + Redis + OpenSearch + WebSocket (V6)
│   ├── clickhouse.ts  # ClickHouse client — table setup, insert, paginated queries (V6)
│   ├── websocket.ts   # WebSocket server — attachWebSocket, broadcast (V5)
│   ├── opensearch.ts  # OpenSearch client — index setup, indexArticle, searchArticles (V4)
│   ├── feeds.ts       # 79 RSS feed configs — URLs + source names (V5)
│   ├── kafka.ts       # Shared Kafka client config — broker address + topic name (V3)
│   ├── rss.ts         # RSS fetching — fetchFeed (single) + fetchAllFeeds (parallel) (V5)
│   ├── redis.ts       # Redis client connection — single shared ioredis instance (V2)
│   ├── store.ts       # Redis storage — capped cache (1,000 articles), eviction logic (V6)
├── shared/
│   └── types.ts       # Shared Article type — imported by both server and client
├── client/
│   ├── index.html     # Vite HTML entry point
│   ├── package.json   # Client dependencies — React, Vite, TypeScript
│   ├── tsconfig.json  # Client TypeScript config
│   └── src/
│       ├── main.tsx       # React entry — mounts the App component into the DOM
│       ├── App.tsx        # Terminal UI — numbered pagination + search + LIVE indicator (V6)
│       └── useArticles.ts # Hooks — useArticles (WebSocket + numbered pages) + useSearch (V6)
├── package.json       # Server deps: Express, ws, rss-parser, ioredis, kafkajs, opensearch, clickhouse/client, tsx
├── tsconfig.json      # Server TypeScript config
└── README.md          # You are here
```
