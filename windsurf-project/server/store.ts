/**
 * WHAT: Redis-backed article storage — uses a Redis Sorted Set to store articles persistently.
 * WHY:  In V1, articles lived in a plain JS array and were lost on every server restart.
 *       Redis fixes three problems at once:
 *       1. PERSISTENCE — articles survive server restarts (Redis writes to disk)
 *       2. DEDUPLICATION — sorted sets reject duplicate members automatically (no manual Set check)
 *       3. SORTED RETRIEVAL — articles are always sorted by score (timestamp), no re-sorting needed
 * HOW:  rss.ts calls addArticles() after fetching the RSS feed. index.ts calls getArticles()
 *       when the REST endpoint is hit. Same interface as V1 — only the internals changed.
 */

import type { Article } from "../shared/types.js";
import redis from "./redis.js";

// V6: Redis is now a CACHE, not the source of truth. ClickHouse stores everything permanently.
// We cap Redis at 1,000 articles — enough for ~20 pages of live feed at 50/page.
const REDIS_MAX_ARTICLES = 1_000;

// --- Redis Key Names ---
// In Redis, every piece of data has a "key" — like a filename in a filesystem.
// We use a prefix ("articles:") so our keys don't collide with other data if Redis is shared.

// The sorted set key — stores article IDs ordered by publish timestamp.
// A sorted set is like an array where each item has a "score" (a number).
// Redis keeps items sorted by score automatically. Our score = publish time in milliseconds.
// WHY a sorted set? Because we always want articles newest-first, and ZREVRANGE gives us that for free.
const ARTICLES_SORTED_SET = "articles:timeline";

// The hash key prefix — stores the full article data for each article.
// A Redis hash is like a JavaScript object: { field: value, field: value }.
// We store one hash per article, keyed by article ID.
// WHY not just store everything in the sorted set? Because sorted set members are just strings —
// we'd have to JSON.stringify the entire article. Hashes let us store structured data natively
// and update individual fields later if needed.
const ARTICLE_HASH_PREFIX = "articles:data:";

/**
 * addArticles — Stores new articles in Redis.
 *
 * For each article, we do two things:
 * 1. ZADD to the sorted set (score = timestamp, member = article ID)
 *    - If the ID already exists, Redis ignores it (NX flag) → free deduplication!
 * 2. HSET to store the full article data as a hash
 *
 * We use a Redis "pipeline" to send all commands in one network round-trip instead of
 * one-at-a-time. This is a key performance concept: batching reduces network overhead.
 *
 * CHANGED FROM V1: Was synchronous (push to array). Now async (talks to Redis over network).
 */
export async function addArticles(newArticles: Article[]): Promise<number> {
  if (newArticles.length === 0) return 0;

  // --- Pipeline 1: ZADD only ---
  // We send all ZADDs first in one batch, then inspect which ones were truly new.
  // This is a two-phase approach: ask Redis what's new, then only store data for those.
  //
  // Why separate from HSET? Previously we interleaved ZADD and HSET in one pipeline:
  //   ZADD article1, HSET article1, ZADD article2, HSET article2 ...
  // The problem: HSET ran unconditionally for EVERY article, even duplicates that ZADD
  // rejected with NX. We were re-writing the same data to Redis for every ingest cycle
  // (every 60 seconds, ~2,900 articles, only a handful new — but all 2,900 got HSet'd).
  // That's like a librarian re-stamping every book in the library just to check if
  // someone returned one new book.
  const zaddPipeline = redis.pipeline();
  for (const article of newArticles) {
    const score = new Date(article.publishedAt).getTime();
    // NX = "only add if Not eXists" — Redis's built-in deduplication.
    zaddPipeline.zadd(ARTICLES_SORTED_SET, "NX", score, article.id);
  }
  const zaddResults = await zaddPipeline.exec();

  // Collect only the articles that were actually new (ZADD returned 1, not 0).
  // These are the ones worth writing full data for.
  const trulyNewArticles: Article[] = [];
  if (zaddResults) {
    for (let i = 0; i < zaddResults.length; i++) {
      const [err, added] = zaddResults[i];
      if (!err && added === 1) {
        trulyNewArticles.push(newArticles[i]);
      }
    }
  }

  // --- Pipeline 2: HSET only for new articles ---
  // Now we only write the full article data for articles that weren't already in Redis.
  if (trulyNewArticles.length > 0) {
    const hsetPipeline = redis.pipeline();
    for (const article of trulyNewArticles) {
      hsetPipeline.hset(ARTICLE_HASH_PREFIX + article.id, {
        id: article.id,
        title: article.title,
        link: article.link,
        publishedAt: article.publishedAt,
        source: article.source,
        description: article.description ?? "",
      });
    }
    await hsetPipeline.exec();
  }

  const newCount = trulyNewArticles.length;
  const duplicates = newArticles.length - newCount;

  // --- Eviction: Cap Redis at REDIS_MAX_ARTICLES ---
  // Instead of calling zcard() first to find out how many to evict, we use Redis negative
  // index notation to directly ask: "give me all members ranked below the top 1,000".
  // zrange(key, 0, -(N+1)) means: from rank 0 up to the (N+1)th-from-the-end.
  // If there are 1,050 articles, this returns ranks 0–49 (the 50 oldest). If there are
  // 980 articles, it returns an empty array — no eviction needed, no extra queries.
  // No zcard() call needed at all: Redis tells us exactly what to delete.
  const evictedIds = await redis.zrange(ARTICLES_SORTED_SET, 0, -(REDIS_MAX_ARTICLES + 1));
  if (evictedIds.length > 0) {
    const trimPipeline = redis.pipeline();
    trimPipeline.zremrangebyrank(ARTICLES_SORTED_SET, 0, -(REDIS_MAX_ARTICLES + 1));
    for (const id of evictedIds) {
      trimPipeline.del(ARTICLE_HASH_PREFIX + id);
    }
    await trimPipeline.exec();
    console.log(`[store] Evicted ${evictedIds.length} old articles from Redis cache (cap: ${REDIS_MAX_ARTICLES}).`);
  }

  console.log(
    `[store] +${newCount} new, ${duplicates} duplicates skipped.`
  );

  return newCount;
}

// The shape returned by paginated queries — includes metadata so the frontend
// knows whether to show a "Load More" button.
export interface PaginatedArticles {
  articles: Article[];
  total: number;    // Total articles in Redis
  page: number;     // Current page (1-indexed)
  limit: number;    // Articles per page
  hasMore: boolean; // True if there are more pages after this one
}

/**
 * getArticles — Retrieves a paginated slice of articles from Redis, sorted newest-first.
 *
 * Uses ZREVRANGE with start/stop offsets to fetch only the requested page.
 * Redis sorted sets support O(log(N) + M) range queries where M = page size,
 * so this is efficient even with thousands of articles.
 *
 * CHANGED: Now accepts page and limit params. Returns PaginatedArticles with metadata.
 */
export async function getArticles(page = 1, limit = 20): Promise<PaginatedArticles> {
  // Get total count first — needed for hasMore calculation.
  const total = await redis.zcard(ARTICLES_SORTED_SET);

  if (total === 0) return { articles: [], total: 0, page, limit, hasMore: false };

  // Calculate the start and stop offsets for ZREVRANGE.
  // Page 1, limit 20 → start=0, stop=19 (first 20 items)
  // Page 2, limit 20 → start=20, stop=39 (next 20 items)
  const start = (page - 1) * limit;
  const stop = start + limit - 1;

  // ZREVRANGE returns members in descending score order (newest first).
  // Unlike fetching ALL articles, we only fetch the requested slice.
  const articleIds = await redis.zrevrange(ARTICLES_SORTED_SET, start, stop);

  if (articleIds.length === 0) return { articles: [], total, page, limit, hasMore: false };

  // For each article ID, fetch its full data from the hash store.
  // We use another pipeline to batch all the HGETALL commands into one request.
  const pipeline = redis.pipeline();
  for (const id of articleIds) {
    // HGETALL returns all fields of a hash as a JavaScript object.
    // For our article hash, that's { id, title, link, publishedAt, source }.
    pipeline.hgetall(ARTICLE_HASH_PREFIX + id);
  }

  const results = await pipeline.exec();

  // Transform the raw Redis results into Article objects.
  // pipeline.exec() returns [error, data] pairs. We extract just the data.
  const articles: Article[] = [];
  if (results) {
    for (const [err, data] of results) {
      // Skip any failed commands or empty hashes.
      if (err || !data || typeof data !== "object") continue;

      // Cast the Redis hash data to our Article type.
      // Redis stores everything as strings, which matches our Article interface perfectly
      // (all our fields are already strings — id, title, link, publishedAt, source).
      const article = data as Record<string, string>;

      // Only include articles that have all required fields.
      if (article.id && article.title && article.link && article.publishedAt) {
        articles.push({
          id: article.id,
          title: article.title,
          link: article.link,
          publishedAt: article.publishedAt,
          source: article.source ?? "Unknown",
          description: article.description || undefined,
        });
      }
    }
  }

  // Calculate whether there are more pages beyond this one.
  const hasMore = (page * limit) < total;

  return { articles, total, page, limit, hasMore };
}
