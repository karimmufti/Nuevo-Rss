/**
 * WHAT: Kafka Consumer — reads articles from Kafka, writes to ClickHouse + Redis + OpenSearch, broadcasts via WebSocket.
 * WHY:  V6 adds ClickHouse as the permanent source of truth for ALL articles (billions scale).
 *       Redis is now a cache (last 1,000 articles). ClickHouse stores everything permanently.
 *       Each store serves a different access pattern:
 *       - ClickHouse: permanent archive, paginated browsing of all history
 *       - Redis: fast cache for the live feed (most recent 1,000)
 *       - OpenSearch: full-text keyword search
 *       - WebSocket: real-time push to connected clients
 * HOW:  Runs inside the Express server process (index.ts calls startConsumer()). Subscribes to
 *       the "articles" topic, deserializes each message, quad-writes to all stores.
 */

// Import the shared Kafka client and topic name.
import { kafka, ARTICLES_TOPIC, ensureTopic } from "./kafka.js";

// Import the Article type so we can deserialize messages correctly.
import type { Article } from "../shared/types.js";

// Import the Redis storage function. Same function we used in V2 — the consumer just calls it
// with articles from Kafka instead of articles from RSS directly.
import { addArticles } from "./store.js";

// V4: Import OpenSearch indexing. bulkIndexArticles sends all articles in one HTTP request
// instead of one request per article. Single indexArticle kept for any one-off use.
import { indexArticle, bulkIndexArticles } from "./opensearch.js";

// V5: Import broadcast to push new articles to connected WebSocket clients instantly.
import { broadcast } from "./websocket.js";

// V6: Import ClickHouse insert. ClickHouse is the permanent source of truth for all articles.
import { insertArticle as clickhouseInsert } from "./clickhouse.js";

// --- Kafka Consumer Setup ---

// Create a Kafka consumer from the shared Kafka client.
// A consumer reads messages from topics. Think of it as a "mail recipient" that picks up
// letters from a mailbox (the Kafka topic) that the producer (ingest worker) dropped off.
const consumer = kafka.consumer({
  // groupId identifies this consumer group. Kafka tracks where each group left off reading.
  // If this consumer crashes and restarts, Kafka remembers the last message it processed
  // and starts from there — no duplicate processing, no missed messages.
  //
  // We use "api-server" as the group ID. If you ran multiple API servers (for load balancing),
  // they'd all use the same group ID and Kafka would distribute messages across them.
  // For V3, we have one API server, so one consumer in the group.
  groupId: "api-server",

  // heartbeatInterval: how often the consumer tells Kafka "I'm still alive" (3 seconds).
  // If Kafka doesn't hear a heartbeat for too long, it assumes the consumer crashed and
  // reassigns its partitions to other consumers in the group.
  heartbeatInterval: 3000,

  // sessionTimeout: how long Kafka waits for a heartbeat before declaring the consumer dead (30 seconds).
  // This is generous to handle brief network hiccups or GC pauses.
  sessionTimeout: 30000,
});

/**
 * startConsumer — Connects to Kafka, subscribes to the articles topic, and processes messages.
 *
 * This function is called once when the Express server starts (in index.ts).
 * It runs forever, processing messages as they arrive. Each message is an article
 * published by the ingest worker. We deserialize it and store it in Redis.
 */
export async function startConsumer(): Promise<void> {
  console.log("[consumer] Starting Kafka consumer...");

  // Connect the consumer to the Kafka broker.
  // This establishes a TCP connection to localhost:9092 (our Redpanda container).
  await consumer.connect();
  console.log("[consumer] Connected to Kafka broker.");

  // Ensure the topic exists with the correct partition count before subscribing.
  await ensureTopic();

  // Subscribe to the "articles" topic.
  // fromBeginning: false means "only read new messages that arrive after I subscribe".
  // If we set it to true, the consumer would read all historical messages in the topic
  // (useful for backfilling data, but not needed here — Redis already has old articles).
  await consumer.subscribe({
    topic: ARTICLES_TOPIC,
    fromBeginning: false,
  });

  console.log(`[consumer] Subscribed to topic: "${ARTICLES_TOPIC}"`);

  // consumer.run() starts the message processing loop.
  // We use eachBatch instead of eachMessage for throughput. eachMessage processes one
  // article at a time — 1,500 articles = 1,500 sequential quad-writes. eachBatch gives
  // us the entire batch at once so we can do bulk writes: one Redis pipeline, one
  // OpenSearch _bulk request, and one ClickHouse buffer flush instead of thousands
  // of individual calls. At 500+ feeds this is the difference between seconds and minutes.
  await consumer.run({
    eachBatch: async ({ batch, heartbeat, resolveOffset, commitOffsetsIfNecessary }) => {
      try {
        // --- Phase 1: Deserialize all messages in the batch ---
        const articles: Article[] = [];
        for (const message of batch.messages) {
          const value = message.value?.toString();
          if (!value) continue;

          try {
            articles.push(JSON.parse(value));
          } catch {
            console.warn(`[consumer] Failed to parse message at offset ${message.offset}, skipping.`);
          }
        }

        if (articles.length === 0) return;

        console.log(`[consumer] Processing batch of ${articles.length} articles...`);

        // --- Phase 2: Bulk-write to all stores in parallel ---
        // Instead of writing one article at a time to each store, we write the entire
        // batch to each store in a single operation. This collapses ~4,500 network
        // round-trips (1,500 × 3 stores) into just 3 bulk requests.
        const [newCount] = await Promise.all([
          // Bulk write 1: Redis — addArticles already handles arrays with pipelines.
          addArticles(articles),

          // Bulk write 2: OpenSearch — one _bulk HTTP request for all articles.
          bulkIndexArticles(articles),

          // Bulk write 3: ClickHouse — insertArticle buffers internally and flushes in bulk.
          // We still call it per-article because the buffer handles batching for us.
          Promise.all(articles.map((a) => clickhouseInsert(a))),
        ]);

        // --- Phase 3: Broadcast new articles via WebSocket ---
        // Only broadcast if Redis confirmed at least some articles were new.
        // We broadcast all articles in the batch — Redis dedup already filtered duplicates
        // from storage, and the frontend also deduplicates by ID on merge.
        if (newCount > 0) {
          for (const article of articles) {
            broadcast(article);
          }
        }

        // --- Phase 4: Commit offsets ---
        // Mark the last message in the batch as processed. If the consumer crashes and
        // restarts, Kafka will replay from this offset — not from the beginning.
        const lastMessage = batch.messages[batch.messages.length - 1];
        resolveOffset(lastMessage.offset);
        await commitOffsetsIfNecessary();
        await heartbeat();

        console.log(`[consumer] Batch done: ${articles.length} articles, ${newCount} new.`);
      } catch (error) {
        console.error("[consumer] Error processing batch:", error);
      }
    },
  });
}

/**
 * stopConsumer — Gracefully disconnects the consumer.
 *
 * Called when the Express server is shutting down (e.g., Ctrl+C, process.exit()).
 * This ensures the consumer commits its offsets (tells Kafka where it stopped reading)
 * before disconnecting. Without this, Kafka might re-deliver the last few messages
 * when the consumer restarts, causing duplicates.
 */
export async function stopConsumer(): Promise<void> {
  console.log("[consumer] Disconnecting Kafka consumer...");
  await consumer.disconnect();
  console.log("[consumer] Kafka consumer disconnected.");
}

// --- Why This File Exists ---
//
// In V2, the Express server fetched RSS directly and stored it in Redis.
// In V3, we split that into two processes:
//   1. Ingest Worker (ingest.ts) — fetches RSS, publishes to Kafka
//   2. API Server (index.ts + consumer.ts) — consumes from Kafka, stores in Redis, serves API
//
// The consumer is the "glue" that connects Kafka to Redis. It's the API server's way of
// receiving articles from the ingest worker without them being in the same process.
//
// Benefits of this architecture:
// - If the API server crashes, the ingest worker keeps publishing to Kafka. When the API
//   server restarts, it picks up where it left off (Kafka remembers the offset).
// - If the ingest worker crashes, the API server keeps serving requests from Redis.
// - You can scale them independently (e.g., 5 ingest workers, 2 API servers).
//
// This is the producer-consumer pattern — a fundamental building block of distributed systems.
