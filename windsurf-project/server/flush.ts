/**
 * One-time script to flush all article data from Redis and OpenSearch.
 * Run with: npx tsx server/flush.ts
 */
import Redis from "ioredis";
import { Client } from "@opensearch-project/opensearch";

async function flush() {
  // --- Flush Redis ---
  const redis = new Redis();
  const keys = await redis.keys("articles:*");
  if (keys.length > 0) {
    await redis.del(...keys);
    console.log(`[flush] Deleted ${keys.length} Redis keys`);
  } else {
    console.log("[flush] No article keys in Redis");
  }
  await redis.quit();

  // --- Flush OpenSearch ---
  const client = new Client({ node: "http://localhost:9200" });
  try {
    const exists = await client.indices.exists({ index: "articles" });
    if (exists.body) {
      await client.indices.delete({ index: "articles" });
      console.log('[flush] Deleted OpenSearch "articles" index');
    } else {
      console.log("[flush] No articles index in OpenSearch");
    }
  } catch (err: any) {
    console.error("[flush] OpenSearch error:", err.message);
  }

  console.log("[flush] Done. Restart the API server so it re-creates the OpenSearch index.");
}

flush();
