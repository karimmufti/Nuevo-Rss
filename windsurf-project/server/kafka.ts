/**
 * WHAT: Shared Kafka client configuration — single source of truth for broker and topic settings.
 * WHY:  Both the ingest worker (producer) and API server (consumer) need to talk to the same
 *       Kafka broker and use the same topic name. Centralizing this config prevents typos and
 *       makes it easy to change the broker address or topic name in one place.
 * HOW:  Exports a Kafka instance (from kafkajs) configured to connect to our local Redpanda broker,
 *       plus the topic name as a constant. Both ingest.ts and consumer.ts import from this file.
 */

// kafkajs is the most popular Kafka client for Node.js. It works with both Apache Kafka
// and Kafka-compatible brokers like Redpanda. We chose kafkajs because it's well-maintained,
// has excellent TypeScript support, and handles connection management + retries automatically.
import { Kafka } from "kafkajs";

// --- Kafka Broker Configuration ---

// Create a Kafka client instance. This doesn't connect yet — it just holds the config.
// The actual connection happens when we create a producer or consumer from this client.
export const kafka = new Kafka({
  // clientId is a label that shows up in Kafka logs. Useful for debugging when you have
  // multiple apps talking to the same broker. We use "live-rss-terminal" to identify our app.
  clientId: "live-rss-terminal",

  // brokers is an array of Kafka broker addresses. In production, you'd have multiple brokers
  // for redundancy (e.g., ["broker1:9092", "broker2:9092", "broker3:9092"]).
  // For local development, we have one Redpanda broker running in Docker on localhost:9092.
  brokers: ["localhost:9092"],

  // retry controls how kafkajs handles connection failures. If Redpanda is temporarily down
  // (e.g., Docker container restarting), kafkajs will retry connecting instead of crashing.
  retry: {
    // initialRetryTime: how long to wait before the first retry (1 second)
    initialRetryTime: 1000,

    // retries: how many times to retry before giving up (8 retries = ~4 minutes total)
    // This is generous because we want the app to survive brief Redpanda restarts.
    retries: 8,
  },
});

// --- Topic Configuration ---

// The name of the Kafka topic where articles are published and consumed.
// A topic is like a named channel or queue. Producers write to it, consumers read from it.
export const ARTICLES_TOPIC = "articles";

// Number of partitions for the articles topic. Partitions are Kafka's unit of parallelism.
// With 1 partition, all articles flow through a single queue — one consumer max.
// With 6 partitions, Kafka splits articles across 6 independent queues:
//   - A single consumer processes all 6 in parallel (kafkajs fetches from each concurrently)
//   - Or you can run up to 6 consumer instances, each handling a subset of partitions
//
// The producer sets key = article.source, so articles from the same feed always land in the
// same partition. This preserves per-feed ordering while distributing load across partitions.
// 6 is a good starting point — enough parallelism without excessive overhead.
export const TOPIC_PARTITIONS = 6;

/**
 * ensureTopic — Creates the articles topic with the configured number of partitions.
 *
 * Called once on startup by the ingest worker (before producing) and the API server
 * (before consuming). If the topic already exists, this is a no-op.
 * If the topic exists with fewer partitions, Kafka ignores the create request —
 * you'd need to manually repartition (rare, and requires rebalancing consumers).
 */
export async function ensureTopic(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();

  try {
    await admin.createTopics({
      topics: [
        {
          topic: ARTICLES_TOPIC,
          numPartitions: TOPIC_PARTITIONS,
          replicationFactor: 1, // Single broker in dev — no replication needed.
        },
      ],
    });
    console.log(`[kafka] Topic "${ARTICLES_TOPIC}" ready (${TOPIC_PARTITIONS} partitions).`);
  } finally {
    await admin.disconnect();
  }
}
