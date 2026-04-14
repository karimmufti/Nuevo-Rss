/**
 * WHAT: Shared TypeScript types used by both the server and the React client.
 * WHY:  The Article shape crosses the API boundary, so both sides must agree on it.
 *       Defining it once here prevents the backend and frontend from drifting apart.
 * HOW:  Server files and client files both import Article from this shared module.
 */

// Article is the core payload that moves through the entire system:
// RSS parser -> Kafka -> Redis / ClickHouse / OpenSearch -> REST / WebSocket -> React UI.
export interface Article {
  // A unique identifier for the article. Usually RSS guid, with link as a fallback.
  id: string;

  // The article headline shown in the UI and indexed in OpenSearch.
  title: string;

  // The canonical URL to the original article.
  link: string;

  // The published timestamp as an ISO 8601 string for easy JSON transport.
  publishedAt: string;

  // The feed/source label shown in the UI, like "BBC News" or "TechCrunch".
  source: string;

  // A short plain-text summary of the article, stripped of HTML tags.
  // Optional because not all RSS feeds include a description field.
  description?: string;
}
