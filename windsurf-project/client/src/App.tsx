/**
 * WHAT: The main React component — a sleek news feed UI with search and numbered pagination.
 * WHY:  This is the "view" layer of V6. It has two modes:
 *       1. BROWSE mode (default): numbered page navigation (50 articles/page)
 *          - Pages 1-20 served from Redis (cache), pages 21+ from ClickHouse (archive)
 *          - Page 1 gets real-time WebSocket push for new articles
 *       2. SEARCH mode: paginated search results from OpenSearch
 * HOW:  Uses two custom hooks: useArticles() and useSearch(), both with pagination.
 *       Features: numbered pagination, ESC to clear search, auto-updating timestamps,
 *       skeleton loading, refresh button, LIVE/OFFLINE WebSocket indicator.
 */

import { useState, useEffect, useRef } from "react";
import { useArticles, useSearch } from "./useArticles";
import "./terminal.css";

// --- Helper Functions ---

/**
 * timeAgo — Converts an ISO date string into a granular relative time.
 * Shows two units for precision: "1h 49m", "3m 12s", "45s", "2d 5h"
 */
function timeAgo(isoDate: string): string {
  const totalSeconds = Math.floor(
    (Date.now() - new Date(isoDate).getTime()) / 1000
  );

  // Future article — show how far ahead it is (e.g. "in 2h 15m").
  // Dates are ambiguous (08/04 = April 8th or August 4th?), relative time is not.
  if (totalSeconds < -60) {
    const futureSeconds = -totalSeconds;
    const fHours = Math.floor(futureSeconds / 3600);
    const fMinutes = Math.floor((futureSeconds % 3600) / 60);
    if (fHours > 0) return `in ${fHours}h${fMinutes > 0 ? ` ${fMinutes}m` : ""}`;
    return `in ${fMinutes}m`;
  }
  if (totalSeconds < 60) return "just now";

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * formatDate — Converts an ISO date string into DD/MM/YYYY format.
 */
function formatDate(isoDate: string): string {
  const d = new Date(isoDate);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * SkeletonCard — A shimmer placeholder that shows while articles are loading.
 * Gives visual feedback that content is on the way.
 */
function SkeletonCard() {
  return (
    <div style={s.card} className="skeleton-card">
      <div style={s.cardTop}>
        <div className="skeleton-line" style={{ width: 80, height: 12, borderRadius: 4 }} />
        <div className="skeleton-line" style={{ width: 140, height: 12, borderRadius: 4 }} />
      </div>
      <div className="skeleton-line" style={{ width: "90%", height: 16, borderRadius: 4, marginTop: 8 }} />
    </div>
  );
}

// --- Main Component ---

export default function App() {
  // V6: Numbered pagination with WebSocket push on page 1.
  const {
    articles, loading, error, total: browseTotal, page, totalPages,
    hasNext, hasPrev, goToPage, refresh, connected,
  } = useArticles();

  // Track spinning state for the refresh button.
  const [refreshing, setRefreshing] = useState(false);
  async function handleRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  // Paginated search hook.
  const {
    results, searching, loadingMore: searchLoadingMore,
    searchError, total: searchTotal, hasMore: searchHasMore,
    search, searchLoadMore, clearSearch,
  } = useSearch();

  const [query, setQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Auto-updating timestamps — force re-render every 30s so relative times stay fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  // ESC keyboard shortcut — clears search from anywhere on the page.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && query) {
        setQuery("");
        clearSearch();
        searchInputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [query, clearSearch]);

  // Debounced search input handler.
  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setQuery(value);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!value.trim()) {
      clearSearch();
      return;
    }

    debounceRef.current = setTimeout(() => search(value), 300);
  }

  // Cleanup debounce on unmount.
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  // Derive display state.
  const isSearching = query.trim().length > 0;
  const displayArticles = isSearching ? results : articles;
  const displayTotal = isSearching ? searchTotal : browseTotal;

  return (
    <div style={s.page}>
      <div style={s.container}>

        {/* --- Header --- */}
        <header style={s.header}>
          <div style={s.headerLeft}>
            <h1 style={s.logo}>
              <span style={s.logoAccent}>RSS</span> Terminal
            </h1>
            <span style={s.version}>v6</span>
          </div>
          <div style={s.headerRight}>
            <span style={s.articleCount}>
              {displayArticles.length}{displayTotal > 0 ? ` / ${displayTotal}` : ""}
            </span>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className={`refresh-btn${refreshing ? " spinning" : ""}`}
              style={s.refreshBtn}
              title="Refresh feed"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 2v6h-6" />
                <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                <path d="M3 22v-6h6" />
                <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              </svg>
            </button>
            <span className={connected ? "live-dot" : "live-dot-off"} />
            <span style={{ ...s.liveLabel, color: connected ? "#22c55e" : "#ef4444" }}>
              {connected ? "LIVE" : "OFFLINE"}
            </span>
          </div>
        </header>

        {/* --- Search Bar --- */}
        <div style={s.searchWrap}>
          <div style={s.searchBar}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              className="search-input"
              value={query}
              onChange={handleSearchChange}
              placeholder="Search articles..."
              style={s.searchInput}
            />
            {query && (
              <button
                className="clear-btn"
                onClick={() => { setQuery(""); clearSearch(); }}
                style={s.clearBtn}
                title="Press ESC to clear"
              >
                ESC
              </button>
            )}
          </div>
        </div>

        {/* --- Status Messages --- */}
        {searching && (
          <div style={s.status}>Searching...</div>
        )}
        {error && !isSearching && (
          <div style={{ ...s.status, color: "#ef4444" }}>
            {error} — retrying...
          </div>
        )}
        {searchError && (
          <div style={{ ...s.status, color: "#ef4444" }}>{searchError}</div>
        )}
        {isSearching && !searching && results.length === 0 && !searchError && (
          <div style={s.status}>No results for "{query}"</div>
        )}

        {/* --- Article Feed --- */}
        <div style={s.feed}>
          {/* Skeleton loading — show placeholder cards during initial load */}
          {loading && !isSearching && displayArticles.length === 0 && (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          )}

          {displayArticles.map((article) => (
            <a
              key={article.id}
              href={article.link}
              target="_blank"
              rel="noopener noreferrer"
              className="article-row"
              style={s.card}
            >
              {/* Top row: source + time info */}
              <div style={s.cardTop}>
                <span style={s.source}>{article.source}</span>
                <div style={s.timeInfo}>
                  <span style={s.date}>{formatDate(article.publishedAt)}</span>
                  <span style={s.timeSep}>&middot;</span>
                  <span style={s.ago}>{timeAgo(article.publishedAt)}</span>
                </div>
              </div>
              {/* Article title */}
              <h2 className="article-link" style={s.title}>{article.title}</h2>
              {/* Description — only rendered when the feed provides one */}
              {article.description && (
                <p style={s.description}>{article.description}</p>
              )}
            </a>
          ))}

          {/* --- Pagination Controls --- */}
          {!isSearching && displayArticles.length > 0 && (
            <div style={s.paginationWrap}>
              <button
                className="page-btn"
                onClick={() => goToPage(1)}
                disabled={!hasPrev}
                style={s.pageBtn}
                title="First page"
              >
                «
              </button>
              <button
                className="page-btn"
                onClick={() => goToPage(page - 1)}
                disabled={!hasPrev}
                style={s.pageBtn}
              >
                ‹ Prev
              </button>

              {/* Numbered page buttons — show a window around current page */}
              {(() => {
                const pages: number[] = [];
                const windowSize = 2;
                const start = Math.max(1, page - windowSize);
                const end = Math.min(totalPages, page + windowSize);
                if (start > 1) pages.push(1);
                if (start > 2) pages.push(-1); // ellipsis
                for (let i = start; i <= end; i++) pages.push(i);
                if (end < totalPages - 1) pages.push(-2); // ellipsis
                if (end < totalPages) pages.push(totalPages);
                return pages.map((p, idx) =>
                  p < 0 ? (
                    <span key={`ellipsis-${idx}`} style={s.ellipsis}>…</span>
                  ) : (
                    <button
                      key={p}
                      className={`page-btn${p === page ? " active" : ""}`}
                      onClick={() => goToPage(p)}
                      style={p === page ? { ...s.pageBtn, ...s.pageBtnActive } : s.pageBtn}
                    >
                      {p}
                    </button>
                  )
                );
              })()}

              <button
                className="page-btn"
                onClick={() => goToPage(page + 1)}
                disabled={!hasNext}
                style={s.pageBtn}
              >
                Next ›
              </button>
              <button
                className="page-btn"
                onClick={() => goToPage(totalPages)}
                disabled={!hasNext}
                style={s.pageBtn}
                title="Last page"
              >
                »
              </button>
            </div>
          )}

          {/* Search Load More (search still uses Load More) */}
          {isSearching && searchHasMore && results.length > 0 && (
            <div style={s.loadMoreWrap}>
              <button
                className="load-more-btn"
                onClick={searchLoadMore}
                disabled={searchLoadingMore}
                style={s.loadMoreBtn}
              >
                {searchLoadingMore ? "Loading..." : "Load More"}
              </button>
              <span style={s.loadMoreHint}>
                Showing {results.length} of {searchTotal}
              </span>
            </div>
          )}
        </div>

        {/* --- Footer --- */}
        <footer style={s.footer}>
          <span>RSS &rarr; Kafka &rarr; ClickHouse + Redis + OpenSearch &rarr; API &rarr; React</span>
          {!isSearching && (
            <span style={s.pageInfo}>
              Page {page} of {totalPages} &middot; {displayTotal.toLocaleString()} articles
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}

// --- Styles ---

const s: Record<string, React.CSSProperties> = {
  page: {
    backgroundColor: "#09090b",
    minHeight: "100vh",
    display: "flex",
    justifyContent: "center",
    padding: "0",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif",
    color: "#fafafa",
  },

  container: {
    width: "100%",
    maxWidth: "720px",
    display: "flex",
    flexDirection: "column" as const,
    minHeight: "100vh",
  },

  // Header
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "20px 24px 16px",
    borderBottom: "1px solid #1c1c1e",
  },

  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },

  logo: {
    fontSize: "18px",
    fontWeight: 700,
    margin: 0,
    color: "#fafafa",
    letterSpacing: "-0.5px",
  },

  logoAccent: {
    color: "#3b82f6",
  },

  version: {
    fontSize: "10px",
    fontWeight: 600,
    color: "#555",
    border: "1px solid #2a2a2e",
    borderRadius: "4px",
    padding: "1px 6px",
    letterSpacing: "0.5px",
  },

  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },

  articleCount: {
    fontSize: "12px",
    color: "#71717a",
    marginRight: "4px",
    fontVariantNumeric: "tabular-nums",
  },

  liveLabel: {
    fontSize: "10px",
    fontWeight: 700,
    color: "#22c55e",
    letterSpacing: "1px",
  },

  // Search
  searchWrap: {
    padding: "12px 24px",
    borderBottom: "1px solid #1c1c1e",
  },

  searchBar: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    backgroundColor: "#18181b",
    borderRadius: "8px",
    padding: "10px 14px",
    border: "1px solid #27272a",
  },

  searchInput: {
    flex: 1,
    backgroundColor: "transparent",
    border: "none",
    outline: "none",
    color: "#fafafa",
    fontSize: "14px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif",
  },

  clearBtn: {
    backgroundColor: "#27272a",
    border: "none",
    color: "#a1a1aa",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: "4px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif",
    letterSpacing: "0.5px",
  },

  // Status
  status: {
    padding: "12px 24px",
    fontSize: "13px",
    color: "#71717a",
    borderBottom: "1px solid #1c1c1e",
  },

  // Feed
  feed: {
    flex: 1,
    overflowY: "auto" as const,
  },

  // Article card
  card: {
    display: "block",
    padding: "16px 24px",
    borderBottom: "1px solid #1c1c1e",
    textDecoration: "none",
    cursor: "pointer",
    transition: "background-color 0.15s ease",
  },

  cardTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "6px",
  },

  source: {
    fontSize: "12px",
    fontWeight: 600,
    color: "#3b82f6",
    letterSpacing: "0.2px",
  },

  timeInfo: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },

  date: {
    fontSize: "12px",
    color: "#52525b",
    fontVariantNumeric: "tabular-nums",
  },

  timeSep: {
    color: "#3f3f46",
    fontSize: "12px",
  },

  ago: {
    fontSize: "12px",
    color: "#71717a",
    fontVariantNumeric: "tabular-nums",
  },

  title: {
    fontSize: "15px",
    fontWeight: 500,
    color: "#e4e4e7",
    margin: 0,
    lineHeight: 1.5,
    transition: "color 0.15s ease",
  },

  description: {
    fontSize: "13px",
    color: "#71717a",
    margin: "5px 0 0",
    lineHeight: 1.5,
    display: "-webkit-box" as any,
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical" as any,
    overflow: "hidden",
  },

  // Pagination
  paginationWrap: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    padding: "16px 24px",
    borderTop: "1px solid #1c1c1e",
  },

  pageBtn: {
    backgroundColor: "#18181b",
    border: "1px solid #27272a",
    color: "#a1a1aa",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 500,
    padding: "6px 10px",
    borderRadius: "4px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif",
    transition: "all 0.15s ease",
    minWidth: "32px",
    textAlign: "center" as const,
  },

  pageBtnActive: {
    backgroundColor: "#3b82f6",
    borderColor: "#3b82f6",
    color: "#fff",
    fontWeight: 700,
  },

  ellipsis: {
    color: "#52525b",
    fontSize: "12px",
    padding: "0 4px",
  },

  pageInfo: {
    display: "block",
    marginTop: "4px",
    fontVariantNumeric: "tabular-nums",
  },

  // Load More (search only)
  loadMoreWrap: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "8px",
    padding: "20px 24px",
  },

  loadMoreBtn: {
    backgroundColor: "#18181b",
    border: "1px solid #27272a",
    color: "#e4e4e7",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 500,
    padding: "8px 24px",
    borderRadius: "6px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif",
    transition: "all 0.15s ease",
  },

  loadMoreHint: {
    fontSize: "11px",
    color: "#52525b",
    fontVariantNumeric: "tabular-nums",
  },

  // Refresh button
  refreshBtn: {
    background: "none",
    border: "1px solid #27272a",
    borderRadius: "6px",
    color: "#71717a",
    cursor: "pointer",
    padding: "4px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "all 0.15s ease",
    marginRight: "2px",
  },

  // Footer
  footer: {
    padding: "14px 24px",
    borderTop: "1px solid #1c1c1e",
    fontSize: "11px",
    color: "#3f3f46",
    textAlign: "center" as const,
  },
};
