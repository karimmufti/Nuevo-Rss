/**
 * WHAT: OpenSearch client setup — creates a client and manages the articles index.
 * WHY:  OpenSearch is a full-text search engine. Redis stores articles for chronological browsing,
 *       but can't efficiently search article titles by keyword. OpenSearch builds an "inverted index"
 *       — a lookup table that maps words to the documents containing them — enabling instant search.
 *       This is the same technology behind Google, Amazon product search, and Wikipedia search.
 * HOW:  Exports three things:
 *       1. The OpenSearch client instance (connected to localhost:9200)
 *       2. ensureIndex() — creates the "articles" index if it doesn't exist (called on startup)
 *       3. indexArticle() — indexes a single article into OpenSearch (called by consumer.ts)
 *       4. searchArticles() — searches for articles by keyword (called by index.ts search endpoint)
 */

// The official OpenSearch client for Node.js. It handles HTTP communication with the
// OpenSearch cluster, request serialization, and error handling.
import { Client } from "@opensearch-project/opensearch";

// Import the Article type so we can type our functions correctly.
import type { Article } from "../shared/types.js";

// --- OpenSearch Client ---

// Create the OpenSearch client. Like Redis and Kafka, OpenSearch runs as a separate server.
// We connect to it over HTTP (not TCP like Redis/Kafka). Port 9200 is the default.
const client = new Client({
  // node: the URL of our local OpenSearch instance running in Docker.
  // In production, you'd have a cluster of nodes (e.g., ["https://node1:9200", "https://node2:9200"]).
  node: "http://localhost:9200",

  // ssl: we disabled the security plugin in Docker (DISABLE_SECURITY_PLUGIN=true),
  // so no SSL/auth needed for local development. In production, you'd use HTTPS + credentials.
});

// --- Index Configuration ---

// The name of the OpenSearch index where articles are stored.
// An index is like a database table — it holds documents of a specific type.
// We use "articles" to match our Kafka topic name for consistency.
const INDEX_NAME = "articles";

// The index mapping defines the schema — what fields each document has and their types.
// This tells OpenSearch HOW to index each field (which affects search behavior).
const INDEX_MAPPING = {
  properties: {
    id: { type: "keyword" as const },
    title: { type: "text" as const },
    link: { type: "keyword" as const },
    publishedAt: { type: "date" as const },
    source: { type: "keyword" as const },
    // description: searchable plain-text summary. Adding this means search now matches
    // on both title AND body text, not just headlines. "inflation" will now match an
    // article titled "Fed Meeting" whose description mentions inflation.
    description: { type: "text" as const },
  },
};

/**
 * ensureIndex — Creates the "articles" index if it doesn't exist.
 *
 * Called once when the API server starts. If the index already exists (from a previous run),
 * this is a no-op. The mapping defines how OpenSearch indexes each field.
 *
 * Think of this like CREATE TABLE IF NOT EXISTS in SQL.
 */
export async function ensureIndex(): Promise<void> {
  try {
    const exists = await client.indices.exists({ index: INDEX_NAME });

    if (!exists.body) {
      await client.indices.create({
        index: INDEX_NAME,
        body: { mappings: INDEX_MAPPING },
      });
      console.log(`[opensearch] Created index "${INDEX_NAME}" with mapping.`);
    } else {
      // Index already exists — try to add the description field to the existing mapping.
      // Only send the new field, not all fields, to avoid conflicts with what's already there.
      // Wrapped in try/catch: a failed mapping update is non-fatal — search still works,
      // just without description until the index is recreated.
      try {
        await client.indices.putMapping({
          index: INDEX_NAME,
          body: { properties: { description: { type: "text" as const } } },
        });
        console.log(`[opensearch] Index "${INDEX_NAME}" mapping updated with description field.`);
      } catch (mappingErr: any) {
        console.warn(`[opensearch] Could not update mapping (non-fatal): ${mappingErr?.message ?? mappingErr}`);
      }
    }
  } catch (error) {
    console.error("[opensearch] Failed to ensure index:", error);
    throw error;
  }
}

/**
 * indexArticle — Indexes a single article into OpenSearch.
 *
 * Called by consumer.ts for each article consumed from Kafka.
 * Uses the article's ID as the document ID — if the same article is indexed twice,
 * OpenSearch overwrites the old document instead of creating a duplicate.
 * This is idempotent — safe to call multiple times with the same article.
 *
 * "Indexing" in search engine terms means "adding a document to the search index".
 * When you index an article, OpenSearch:
 * 1. Tokenizes the title ("Climate talks resume" → ["climate", "talks", "resume"])
 * 2. Adds each token to the inverted index (token → list of document IDs)
 * 3. Stores the full document for retrieval
 */
export async function indexArticle(article: Article): Promise<void> {
  await client.index({
    // index: which index to write to (our "articles" index)
    index: INDEX_NAME,

    // id: the document ID. Using article.id means re-indexing the same article
    // overwrites the old version instead of creating a duplicate.
    id: article.id,

    // body: the document data. This is what gets indexed and stored.
    body: {
      id: article.id,
      title: article.title,
      link: article.link,
      publishedAt: article.publishedAt,
      source: article.source,
      description: article.description ?? "",
    },
  });
}

/**
 * bulkIndexArticles — Indexes many articles in a single HTTP request.
 *
 * The _bulk API is OpenSearch's batch endpoint. Instead of 500 individual index()
 * calls (500 HTTP round-trips), we send one request with all 500 documents.
 * The request body alternates action lines and document lines:
 *   { index: { _index: "articles", _id: "abc" } }
 *   { id: "abc", title: "...", ... }
 *   { index: { _index: "articles", _id: "def" } }
 *   { id: "def", title: "...", ... }
 *
 * This is the same pattern Logstash and Beats use to ship millions of events/sec.
 */
export async function bulkIndexArticles(articles: Article[]): Promise<void> {
  if (articles.length === 0) return;

  // Build the bulk request body — alternating action + document lines.
  const body: any[] = [];
  for (const article of articles) {
    // Action line: tells OpenSearch what to do (index) and where (_index, _id).
    body.push({ index: { _index: INDEX_NAME, _id: article.id } });
    // Document line: the actual data to index.
    body.push({
      id: article.id,
      title: article.title,
      link: article.link,
      publishedAt: article.publishedAt,
      source: article.source,
      description: article.description ?? "",
    });
  }

  const result = await client.bulk({ body });

  if (result.body.errors) {
    const failed = result.body.items.filter((item: any) => item.index?.error);
    console.error(`[opensearch] Bulk index: ${failed.length}/${articles.length} failed.`);
  }
}

// The shape returned by paginated search — matches the store's PaginatedArticles format
// so the frontend can handle both /api/articles and /api/search the same way.
interface PaginatedSearchResults {
  articles: Article[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * searchArticles — Searches for articles matching a keyword query, with pagination.
 *
 * Uses OpenSearch's "multi_match" query to search across the title field.
 * Returns articles sorted by relevance (best matches first).
 * Supports pagination via "from" (offset) and "size" (limit) parameters.
 *
 * OpenSearch natively supports pagination: "from" skips N results, "size" returns N results.
 * It also returns total hit count in the response, so we can calculate hasMore.
 */
export async function searchArticles(query: string, page = 1, limit = 20): Promise<PaginatedSearchResults> {
  // Calculate the "from" offset for OpenSearch pagination.
  // Page 1 → from=0, Page 2 → from=20, etc.
  const from = (page - 1) * limit;

  const result = await client.search({
    index: INDEX_NAME,
    body: {
      from: from,
      size: limit,

      // query: the search criteria. We use multi_match to search across the title field.
      query: {
        multi_match: {
          query: query,
          // Search across both title and description. Title matches are weighted
          // higher (^2) because a headline match is more relevant than a body match.
          fields: ["title^2", "description"],
          fuzziness: "AUTO",
        },
      },

      // sort: secondary sort by publishedAt descending. If two articles have the same
      // relevance score, the newer one appears first.
      sort: [
        { _score: { order: "desc" } },
        { publishedAt: { order: "desc" } },
      ],
    },
  });

  // OpenSearch returns the total hit count in result.body.hits.total.value
  const hits = result.body.hits.hits;
  const rawTotal = result.body.hits.total;
  const total = typeof rawTotal === "number" ? rawTotal : (rawTotal?.value ?? 0);

  const articles = hits.map((hit: any) => ({
    id: hit._source.id,
    title: hit._source.title,
    link: hit._source.link,
    publishedAt: hit._source.publishedAt,
    source: hit._source.source,
    description: hit._source.description || undefined,
  }));

  const hasMore = (page * limit) < total;

  return { articles, total, page, limit, hasMore };
}

// Export the client for direct access if needed (e.g., health checks).
export default client;
