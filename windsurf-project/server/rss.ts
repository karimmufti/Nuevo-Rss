/**
 * WHAT: RSS fetching logic — downloads and parses RSS feeds from multiple sources.
 * WHY:  This is the "ingest" layer of our pipeline. Called by the ingest worker (ingest.ts),
 *       which publishes the articles to Kafka. Pure parsing — no storage, no side effects.
 * HOW:  fetchFeed() fetches a single feed URL and returns Articles.
 *       fetchAllFeeds() fetches all configured feeds in parallel using Promise.allSettled()
 *       so one failing feed doesn't block the others.
 */

import RssParser from "rss-parser";

import type { Article } from "../shared/types.js";
import { FEEDS, FeedConfig } from "./feeds.js";

// Create a single parser instance with a custom User-Agent header.
// Some feeds block requests without a proper User-Agent.
const parser = new RssParser({
  headers: {
    "User-Agent": "LiveRSSTerminal/4.0 (+https://github.com/live-rss-terminal)",
  },
  // Timeout after 10 seconds per feed to avoid one slow feed blocking the whole cycle.
  timeout: 10_000,
});

/**
 * fetchFeed — Fetches a single RSS feed and transforms items into Articles.
 *
 * Accepts a FeedConfig (url + source name) and returns an array of Articles.
 * If the feed fails (network error, invalid XML, etc.), this throws — the caller handles it.
 */
export async function fetchFeed(feed: FeedConfig): Promise<Article[]> {
  const parsed = await parser.parseURL(feed.url);

  // Only take the 20 most recent items per feed.
  // RSS feeds return items newest-first, so slice(0, 20) = the 20 latest.
  // Previously we consumed every historical item on every cycle (~40 per feed),
  // flooding Kafka and Redis with thousands of articles that were already in the system.
  // With 68 feeds × 20 items = max 1,360 articles per cycle instead of ~2,900.
  return parsed.items.slice(0, 20).map((item) => {
    // Some feeds return guid as an object (e.g., { _: "url", isPermaLink: "true" })
    // instead of a plain string. Coerce it to avoid crashing the Kafka partitioner.
    const rawId = item.guid ?? item.link ?? "";
    const id = typeof rawId === "object" ? (rawId as any)._ ?? JSON.stringify(rawId) : String(rawId);

    // contentSnippet is rss-parser's pre-stripped plain-text version of the description —
    // it removes HTML tags so we don't store "<p>Breaking news...</p>" in our DB.
    // Fall back to summary (Atom feeds) or leave empty if neither exists.
    const description = (item.contentSnippet ?? item.summary ?? "").trim().slice(0, 300);

    return {
      id,
      title: item.title ?? "Untitled",
      link: item.link ?? "",
      publishedAt: item.isoDate ?? new Date().toISOString(),
      source: feed.source,
      description: description || undefined,
    };
  });
}

// --- Concurrency Limiter ---
// Firing all feeds at once (Promise.allSettled(FEEDS.map(...))) works at 79 feeds,
// but at 500+ feeds it opens hundreds of simultaneous TCP connections. This causes:
//   1. File descriptor exhaustion (OS limit, typically 1024 on macOS)
//   2. Mass timeouts — too many connections competing for bandwidth
//   3. Rate limiting — news sites block IPs making 500 simultaneous requests
//
// The fix: limit concurrency to MAX_CONCURRENT feeds in-flight at once.
// 25 is a good balance — fast enough to finish 500 feeds in ~3 waves of 10s each,
// but not so many that we overwhelm the network or get rate-limited.
const MAX_CONCURRENT = 25;

/**
 * runWithConcurrency — Executes async tasks with a concurrency cap.
 *
 * Like Promise.allSettled() but only runs MAX_CONCURRENT tasks at a time.
 * As one task finishes, the next one starts — keeping the pipeline full
 * without overwhelming the network. Think of it as a thread pool.
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason: any) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  // Spawn `limit` workers that each pull from the task queue.
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

/**
 * fetchAllFeeds — Fetches ALL configured feeds with concurrency control.
 *
 * Runs up to MAX_CONCURRENT feed fetches at a time. As each feed completes
 * (success or failure), the next feed starts immediately — no idle slots.
 * Failed feeds are logged but don't block others.
 */
export async function fetchAllFeeds(): Promise<Article[]> {
  console.log(`[rss] Fetching ${FEEDS.length} feeds (max ${MAX_CONCURRENT} concurrent)...`);

  // Build an array of lazy tasks — each one fetches a single feed.
  // They're functions (not promises) so they don't start until the worker calls them.
  const tasks = FEEDS.map((feed) => () => fetchFeed(feed));

  const results = await runWithConcurrency(tasks, MAX_CONCURRENT);

  const allArticles: Article[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      allArticles.push(...result.value);
      successCount++;
    } else {
      failCount++;
      console.warn(`[rss] Failed to fetch "${FEEDS[i].source}": ${result.reason?.message ?? result.reason}`);
    }
  }

  console.log(
    `[rss] Fetched ${allArticles.length} articles from ${successCount}/${FEEDS.length} feeds` +
    (failCount > 0 ? ` (${failCount} failed)` : "")
  );

  return allArticles;
}
