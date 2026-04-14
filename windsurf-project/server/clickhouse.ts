/**
 * WHAT: ClickHouse client — permanent storage for ALL articles (billions scale).
 * WHY:  Redis is a cache (last 1,000 articles). ClickHouse is the source of truth.
 *       ClickHouse is a column-oriented OLAP database optimized for:
 *       - Append-only writes (articles are never updated/deleted)
 *       - Time-ordered data (MergeTree engine sorts by published_at)
 *       - Low-latency paginated reads (ORDER BY published_at DESC LIMIT N OFFSET M)
 *       At billions of rows, ClickHouse handles paginated queries in milliseconds.
 * HOW:  The consumer writes every article to ClickHouse. The API reads from ClickHouse
 *       when the user browses archive pages beyond what Redis holds.
 */

import { createClient } from "@clickhouse/client";
import type { Article } from "../shared/types.js";

// ClickHouse client — connects to the HTTP interface, usually localhost:8123.
// We read credentials from env vars, but we also provide local-dev defaults that
// match the Docker command in the README so plain `npm run dev` works out of the box.
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE ?? "default";
const CLICKHOUSE_USERNAME = process.env.CLICKHOUSE_USER ?? "rss_app";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "rss_app_password";

// The native protocol (port 9000) is also available but the HTTP interface
// is simpler and works well with the official Node.js client.
const client = createClient({
  url: CLICKHOUSE_URL,
  database: CLICKHOUSE_DATABASE,
  username: CLICKHOUSE_USERNAME,
  password: CLICKHOUSE_PASSWORD,
});

// --- Table Schema ---
// MergeTree is ClickHouse's core table engine. It stores data sorted by the
// ORDER BY key (published_at, id) which makes time-range queries extremely fast.
// ReplacingMergeTree deduplicates rows with the same ORDER BY key on merges —
// so re-inserting the same article is safe (idempotent).
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS articles (
    id          String,
    title       String,
    link        String,
    published_at DateTime64(3),
    source      String,
    description String DEFAULT ''
  )
  ENGINE = ReplacingMergeTree()
  ORDER BY (published_at, id)
`;

// For existing tables created before description was added, add the column if missing.
// ALTER TABLE ... ADD COLUMN IF NOT EXISTS is a no-op when the column already exists.
const ALTER_TABLE_SQL = `
  ALTER TABLE articles ADD COLUMN IF NOT EXISTS description String DEFAULT ''
`;

/**
 * ensureTable — Creates the articles table if it doesn't exist.
 * Called once on server startup (same pattern as OpenSearch ensureIndex).
 */
export async function ensureTable(): Promise<void> {
  await client.command({ query: CREATE_TABLE_SQL });
  // Add description column to existing tables that predate this field.
  await client.command({ query: ALTER_TABLE_SQL });
  console.log("[clickhouse] Table 'articles' ready.");
}

// --- Batched Insert Buffer ---
// ClickHouse is designed for bulk inserts — thousands of rows per INSERT.
// Single-row inserts create one "data part" per INSERT on disk. At high throughput
// (e.g., 1,500 articles per ingest cycle) this floods ClickHouse with tiny parts,
// causing TOO_MANY_UNEXPECTED_DATA_PARTS errors and eventually crashing the server.
//
// The fix: buffer articles in memory and flush them in bulk. We flush when either:
//   1. The buffer reaches BATCH_SIZE (500 articles), OR
//   2. FLUSH_INTERVAL_MS (1 second) has passed since the last flush
// Whichever comes first. This gives ClickHouse large, efficient inserts while
// keeping end-to-end latency under 1 second for real-time push.

const BATCH_SIZE = 500;
const FLUSH_INTERVAL_MS = 1_000;

// The buffer holds articles waiting to be flushed to ClickHouse.
let buffer: Article[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * flushBuffer — Writes all buffered articles to ClickHouse in a single INSERT.
 *
 * One INSERT with 500 rows creates ONE data part. 500 single-row INSERTs create
 * 500 data parts. ClickHouse merges parts in the background, but if you create
 * them faster than merges can keep up, the server crashes. Batching prevents this.
 */
async function flushBuffer(): Promise<void> {
  // Clear the timer so we don't double-flush.
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  // Swap the buffer out atomically — grab the current articles and reset to empty.
  // This way, new articles that arrive during the flush go into a fresh buffer
  // instead of being lost or causing a concurrent modification.
  const batch = buffer;
  buffer = [];

  if (batch.length === 0) return;

  await client.insert({
    table: "articles",
    values: batch.map((article) => ({
      id: article.id,
      title: article.title,
      link: article.link,
      published_at: new Date(article.publishedAt).getTime(),
      source: article.source,
      description: article.description ?? "",
    })),
    format: "JSONEachRow",
  });

  console.log(`[clickhouse] Flushed ${batch.length} articles in one bulk insert.`);
}

/**
 * scheduleFlush — Starts the timer that auto-flushes after FLUSH_INTERVAL_MS.
 *
 * Called every time an article is added to the buffer. If a timer is already
 * running, this is a no-op — we don't reset the timer on every article because
 * that would delay the flush indefinitely under continuous load.
 */
function scheduleFlush(): void {
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushBuffer().catch((err) =>
        console.error("[clickhouse] Error flushing buffer:", err)
      );
    }, FLUSH_INTERVAL_MS);
  }
}

/**
 * insertArticle — Adds an article to the batch buffer.
 *
 * Instead of inserting immediately (which creates one ClickHouse data part per call),
 * articles are buffered and flushed in bulk. The caller's interface is unchanged —
 * consumer.ts still calls insertArticle(article) the same way.
 */
export async function insertArticle(article: Article): Promise<void> {
  buffer.push(article);

  // If the buffer is full, flush immediately (don't wait for the timer).
  if (buffer.length >= BATCH_SIZE) {
    await flushBuffer();
  } else {
    // Otherwise, schedule a flush in 1 second (if not already scheduled).
    scheduleFlush();
  }
}

// The shape returned by paginated archive queries.
export interface PaginatedArchive {
  articles: Article[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * getArchivePage — Fetches a paginated slice of articles from ClickHouse.
 *
 * Sorted by published_at DESC (newest first). ClickHouse handles OFFSET/LIMIT
 * efficiently even at billions of rows because data is physically sorted by time.
 */
export async function getArchivePage(page = 1, limit = 50): Promise<PaginatedArchive> {
  // Get total count — ClickHouse caches this for MergeTree tables.
  const countResult = await client.query({
    query: "SELECT count() as cnt FROM articles",
    format: "JSONEachRow",
  });
  const countRows = await countResult.json<{ cnt: string }>();
  const total = parseInt(countRows[0]?.cnt ?? "0", 10);

  if (total === 0) return { articles: [], total: 0, page, limit, hasMore: false };

  const offset = (page - 1) * limit;

  // Paginated query — ORDER BY published_at DESC is fast because MergeTree
  // stores data sorted by (published_at, id). ClickHouse just scans the index.
  const result = await client.query({
    query: `
      SELECT id, title, link, published_at, source, description
      FROM articles
      ORDER BY published_at DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
    query_params: { limit, offset },
    format: "JSONEachRow",
  });

  const rows = await result.json<{
    id: string;
    title: string;
    link: string;
    published_at: string;
    source: string;
    description: string;
  }>();

  const articles: Article[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    link: row.link,
    publishedAt: new Date(row.published_at).toISOString(),
    source: row.source,
    description: row.description || undefined,
  }));

  const hasMore = offset + limit < total;

  return { articles, total, page, limit, hasMore };
}

/**
 * getTotalArticles — Returns the total count of articles in ClickHouse.
 * Used by the API to report the true total (not just Redis cache size).
 */
export async function getTotalArticles(): Promise<number> {
  const result = await client.query({
    query: "SELECT count() as cnt FROM articles",
    format: "JSONEachRow",
  });
  const rows = await result.json<{ cnt: string }>();
  return parseInt(rows[0]?.cnt ?? "0", 10);
}
