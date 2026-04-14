/**
 * WHAT: Custom React hooks for fetching articles and searching, with numbered pagination and WebSocket.
 * WHY:  useArticles() shows one page at a time (50 articles/page). Page 1 gets real-time
 *       WebSocket push. Navigating to another page fetches it on demand from the API.
 *       The API auto-routes: recent pages from Redis (cache), archive pages from ClickHouse.
 * HOW:  useArticles() fetches GET /api/articles?page=N&limit=50. goToPage(N) replaces the
 *       current articles with page N. WebSocket only inserts on page 1 (the live feed).
 *       useSearch() calls GET /api/search?q=<query>&page=1&limit=50, with its own pagination.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { Article } from "../../shared/types";

// The paginated response shape returned by both API endpoints.
interface PaginatedResponse {
  articles: Article[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

// WebSocket message shape — the server sends { type: "new_article", article: Article }.
interface WsMessage {
  type: string;
  article?: Article;
  clients?: number;
}

const API_URL = "http://localhost:3001/api/articles";
const SEARCH_URL = "http://localhost:3001/api/search";
const WS_URL = "ws://localhost:3001";
const PAGE_SIZE = 50;

// Helper: deduplicate by id AND title (catches cross-feed dupes), then sort newest-first.
function dedupAndSort(list: Article[]): Article[] {
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const unique: Article[] = [];

  for (const a of list) {
    const titleKey = a.title.toLowerCase().trim();
    if (seenIds.has(a.id) || seenTitles.has(titleKey)) continue;
    seenIds.add(a.id);
    seenTitles.add(titleKey);
    unique.push(a);
  }

  return unique.sort((a, b) =>
    new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );
}

/**
 * useArticles — Numbered pagination (50/page) with real-time WebSocket push on page 1.
 *
 * V6 CHANGE: Replaced "Load More" with numbered pages. Each page shows exactly 50 articles.
 * Page 1 receives WebSocket push for new articles. Other pages are fetched on demand.
 * The API transparently routes to Redis (pages 1-20) or ClickHouse (pages 21+).
 */
export function useArticles() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [connected, setConnected] = useState(false);

  // Track current page in a ref so the WebSocket callback always sees the latest value.
  const pageRef = useRef(1);

  // fetchPage — fetches a specific page from the REST API and REPLACES current articles.
  const fetchPage = useCallback(async (pageNum: number) => {
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}?page=${pageNum}&limit=${PAGE_SIZE}`);
      if (!response.ok) throw new Error(`Server returned ${response.status}`);

      const data: PaginatedResponse = await response.json();
      setArticles(dedupAndSort(data.articles));
      setTotal(data.total);
      setPage(pageNum);
      pageRef.current = pageNum;
      setError(null);
    } catch (err) {
      console.error("[useArticles] Fetch failed:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch articles");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch (page 1) on mount.
  useEffect(() => {
    fetchPage(1);
  }, [fetchPage]);

  // WebSocket connection — receives new articles in real-time.
  // Only inserts articles when the user is viewing page 1 (the live feed).
  // On other pages, WebSocket still updates the total count but doesn't insert articles.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let unmounted = false;

    function connect() {
      if (unmounted) return;
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        console.log("[ws] Connected to server");
        setConnected(true);
        setError(null);
      };

      ws.onmessage = (event) => {
        try {
          const msg: WsMessage = JSON.parse(event.data);

          if (msg.type === "new_article" && msg.article) {
            const article = msg.article;

            // Always increment total (new article exists in the system).
            setTotal(t => t + 1);

            // Only insert into the visible list if we're on page 1 (the live feed).
            // On archive pages, the user is browsing history — don't disrupt that.
            if (pageRef.current === 1) {
              setArticles(prev => {
                const merged = dedupAndSort([article, ...prev]);
                // Cap at PAGE_SIZE so page 1 doesn't grow unbounded.
                return merged.slice(0, PAGE_SIZE);
              });
            }
          }
        } catch (err) {
          console.error("[ws] Failed to parse message:", err);
        }
      };

      ws.onclose = () => {
        console.log("[ws] Disconnected from server");
        setConnected(false);
        if (!unmounted) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = (err) => {
        console.error("[ws] WebSocket error:", err);
        ws?.close();
      };
    }

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  // goToPage — navigate to a specific page number. Fetches from API on demand.
  const goToPage = useCallback((pageNum: number) => {
    fetchPage(pageNum);
  }, [fetchPage]);

  // refresh — re-fetch the current page.
  const refresh = useCallback(() => fetchPage(pageRef.current), [fetchPage]);

  // Computed pagination values.
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  return {
    articles, loading, error, total, page, totalPages,
    hasNext, hasPrev, goToPage, refresh, connected,
  };
}

/**
 * useSearch — Paginated search with "Load More" support.
 *
 * A new query resets to page 1. loadMore() appends the next page of results.
 */
export function useSearch() {
  const [results, setResults] = useState<Article[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const currentQuery = useRef("");

  // search() — triggers a fresh search (page 1). Resets results.
  async function search(query: string) {
    if (!query.trim()) {
      clearSearch();
      return;
    }

    currentQuery.current = query.trim();
    setSearching(true);
    setSearchError(null);
    setPage(1);

    try {
      const response = await fetch(
        `${SEARCH_URL}?q=${encodeURIComponent(query.trim())}&page=1&limit=${PAGE_SIZE}`
      );
      if (!response.ok) throw new Error(`Search returned ${response.status}`);

      const data: PaginatedResponse = await response.json();
      setResults(data.articles);
      setTotal(data.total);
      setHasMore(data.hasMore);
    } catch (err) {
      console.error("[useSearch] Search failed:", err);
      setSearchError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }

  // loadMore() — fetches the next page of search results.
  async function searchLoadMore() {
    if (!currentQuery.current) return;
    const nextPage = page + 1;
    setLoadingMore(true);

    try {
      const response = await fetch(
        `${SEARCH_URL}?q=${encodeURIComponent(currentQuery.current)}&page=${nextPage}&limit=${PAGE_SIZE}`
      );
      if (!response.ok) throw new Error(`Search returned ${response.status}`);

      const data: PaginatedResponse = await response.json();
      setResults(prev => [...prev, ...data.articles]);
      setTotal(data.total);
      setHasMore(data.hasMore);
      setPage(nextPage);
    } catch (err) {
      console.error("[useSearch] Load more failed:", err);
      setSearchError(err instanceof Error ? err.message : "Load more failed");
    } finally {
      setLoadingMore(false);
    }
  }

  function clearSearch() {
    setResults([]);
    setSearchError(null);
    setSearching(false);
    setTotal(0);
    setHasMore(false);
    setPage(1);
    currentQuery.current = "";
  }

  return { results, searching, loadingMore, searchError, total, hasMore, search, searchLoadMore, clearSearch };
}
