/**
 * WHAT: Ingest Worker — standalone process that fetches 85+ RSS feeds and publishes to Kafka.
 * WHY:  In V2, the Express server did both RSS fetching AND API serving. If the server crashed,
 *       both stopped. In V3, we decouple these concerns: the ingest worker only fetches RSS,
 *       the API server only serves requests. They communicate via Kafka (the message queue).
 *       This is the producer-consumer pattern — a fundamental distributed systems concept.
 * HOW:  Runs as a separate Node.js process (npm run ingest). Fetches all configured feeds in
 *       parallel every 60 seconds, publishes each article as a Kafka message to the "articles"
 *       topic. The API server's consumer (consumer.ts) reads from that topic and stores in Redis.
 */

// Import the shared Kafka client and topic name from kafka.ts.
// This ensures the producer and consumer use the same broker and topic — no typos, no mismatches.
import { kafka, ARTICLES_TOPIC, ensureTopic } from "./kafka.js";

// Import the RSS fetching function. rss.ts is pure — it just fetches and parses,
// no side effects. fetchAllFeeds() fetches all 85+ configured feeds in parallel.
import { fetchAllFeeds } from "./rss.js";

// --- Kafka Producer Setup ---

// Create a Kafka producer from the shared Kafka client.
// A producer sends messages to topics. Think of it as a "mail sender" that drops letters
// in a mailbox (the Kafka topic). The consumer (API server) picks up those letters later.
const producer = kafka.producer({
  // allowAutoTopicCreation: true tells Kafka to create the topic if it doesn't exist yet.
  // This is convenient for development — we don't have to manually create the topic first.
  // In production, you'd typically create topics explicitly with specific configs (partitions, replication).
  allowAutoTopicCreation: true,

  // transactionalId: we don't use transactions in V3 (that's an advanced Kafka feature for
  // exactly-once semantics). Leaving this undefined means we use "at-least-once" delivery —
  // messages might be delivered more than once if there's a retry, but never lost.
  // Our Redis deduplication (ZADD NX) handles duplicates, so this is fine.
});

/**
 * publishArticles — Publishes an array of articles to the Kafka topic.
 *
 * Each article becomes one Kafka message. We batch them into a single send() call for efficiency.
 * Kafka is optimized for batching — sending 38 messages in one request is much faster than
 * 38 separate requests (fewer network round-trips, better compression).
 */
async function publishArticles(articles: any[]): Promise<void> {
  // If there are no articles (e.g., RSS fetch failed), skip publishing.
  if (articles.length === 0) {
    console.log("[ingest] No articles to publish.");
    return;
  }

  // Send articles in chunks to avoid exceeding Redpanda's default 1MB message size limit.
  // With ~2,900 articles per cycle, a single send() easily blows past that limit.
  const CHUNK_SIZE = 100;
  for (let i = 0; i < articles.length; i += CHUNK_SIZE) {
    const chunk = articles.slice(i, i + CHUNK_SIZE);
    await producer.send({
      topic: ARTICLES_TOPIC,
      messages: chunk.map((article) => ({
        value: JSON.stringify(article),
        // Use source (feed name) as the partition key. Kafka hashes this to pick a partition.
        // Articles from the same feed always land in the same partition, preserving per-feed
        // ordering. Different feeds spread across all 6 partitions for parallel processing.
        key: article.source,
      })),
    });
  }

  console.log(`[ingest] Published ${articles.length} articles to Kafka topic "${ARTICLES_TOPIC}".`);
}

/**
 * ingestLoop — The main loop: fetch RSS, publish to Kafka, repeat every 60 seconds.
 *
 * This is the heartbeat of the ingest worker. It runs forever (until you kill the process).
 * If RSS fetching fails, we log the error and try again next cycle — graceful degradation.
 */
async function ingestLoop(): Promise<void> {
  while (true) {
    // Record when this cycle started BEFORE doing any work.
    // This is how we fix interval drift.
    //
    // The old code: work() then sleep(60s). If work takes 12s, total cycle = 72s.
    // Over 24 hours that's 1,200 cycles instead of 1,440 — a 17% slowdown.
    // Like a bus that waits 60 minutes after the last passenger boards instead
    // of leaving every 60 minutes on the clock. Over a day it falls way behind schedule.
    //
    // The fix: record the clock time at the start, do the work, then sleep only
    // for whatever's left of the 60 seconds. If work took 12s, sleep 48s.
    // The next cycle starts at exactly 60s after the previous one began.
    const cycleStart = Date.now();

    try {
      const articles = await fetchAllFeeds();
      await publishArticles(articles);
    } catch (error) {
      console.error("[ingest] Error in ingest loop:", error);
    }

    const elapsed = Date.now() - cycleStart;
    const remaining = Math.max(0, 60_000 - elapsed);
    console.log(`[ingest] Cycle took ${(elapsed / 1000).toFixed(1)}s. Next fetch in ${(remaining / 1000).toFixed(1)}s.`);
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

/**
 * Main entry point — connects the producer and starts the ingest loop.
 */
async function main() {
  console.log("[ingest] Starting RSS Ingest Worker...");
  console.log(`[ingest] Will publish to Kafka topic: "${ARTICLES_TOPIC}"`);

  // Connect the producer to the Kafka broker.
  // This establishes a TCP connection to localhost:9092 (our Redpanda container).
  // If Redpanda isn't running, this will throw an error and the process will exit.
  await producer.connect();
  console.log("[ingest] Connected to Kafka broker.");

  // Ensure the topic exists with the right number of partitions before producing.
  // If the topic was auto-created with 1 partition, this won't change it —
  // you'd need to delete and recreate it (or use kafka-topics --alter).
  await ensureTopic();

  // Start the ingest loop. This runs forever (or until the process is killed).
  // Fetch immediately on startup, then every 60 seconds after that.
  await ingestLoop();
}

// --- Graceful Shutdown ---

// Listen for SIGINT (Ctrl+C) and SIGTERM (docker stop, kill command) signals.
// When the process is being killed, we disconnect the producer cleanly instead of
// abruptly closing the connection. This ensures any in-flight messages are flushed.
process.on("SIGINT", async () => {
  console.log("\n[ingest] Received SIGINT, shutting down gracefully...");
  await producer.disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[ingest] Received SIGTERM, shutting down gracefully...");
  await producer.disconnect();
  process.exit(0);
});

// Start the ingest worker.
main().catch((error) => {
  // If main() throws (e.g., can't connect to Kafka), log the error and exit.
  // In production, you'd use a process manager (PM2, systemd) to auto-restart on crashes.
  console.error("[ingest] Fatal error:", error);
  process.exit(1);
});
