/**
 * WHAT: RSS feed configuration — a list of all news sources we ingest.
 * WHY:  Centralizes feed URLs and source names in one place. The ingest worker
 *       iterates over this array each cycle, fetching all feeds in parallel.
 * HOW:  Each entry has a url (the RSS/Atom feed URL) and a source (display name).
 *       Add or remove feeds here — no other files need to change.
 */

export interface FeedConfig {
  url: string;    // The RSS/Atom feed URL
  source: string; // Display name shown in the UI (e.g., "BBC News")
}

export const FEEDS: FeedConfig[] = [
  // --- Major World News ---
  { url: "https://feeds.bbci.co.uk/news/rss.xml", source: "BBC News" },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", source: "BBC World" },
  { url: "https://feeds.bbci.co.uk/news/technology/rss.xml", source: "BBC Tech" },
  { url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", source: "BBC Science" },
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml", source: "BBC Business" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", source: "NYT" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", source: "NYT World" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml", source: "NYT Tech" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/Science.xml", source: "NYT Science" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", source: "NYT Business" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml", source: "NYT Politics" },

  // --- Reuters & AP ---
  // Reuters and AP direct feeds are blocked (403/404). Removed to stop wasting a 10s timeout each cycle.

  // --- US News ---
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", source: "CNBC" },
  { url: "https://www.cnbc.com/id/10001147/device/rss/rss.html", source: "CNBC Tech" },
  { url: "https://abcnews.go.com/abcnews/topstories", source: "ABC News" },
  { url: "https://feeds.npr.org/1001/rss.xml", source: "NPR" },
  { url: "https://feeds.npr.org/1019/rss.xml", source: "NPR Tech" },
  { url: "https://feeds.washingtonpost.com/rss/world", source: "Washington Post" },
  // WaPo Tech consistently times out — removed.
  // { url: "https://feeds.washingtonpost.com/rss/business/technology", source: "WaPo Tech" },

  // --- Tech ---
  { url: "https://www.theverge.com/rss/index.xml", source: "The Verge" },
  { url: "https://techcrunch.com/feed/", source: "TechCrunch" },
  { url: "https://www.wired.com/feed/rss", source: "Wired" },
  { url: "https://arstechnica.com/feed/", source: "Ars Technica" },
  { url: "https://feeds.feedburner.com/TheHackersNews", source: "Hacker News (THN)" },
  { url: "https://www.engadget.com/rss.xml", source: "Engadget" },
  // ZDNet intermittently times out — removed.
  { url: "https://feeds.macrumors.com/MacRumors-All", source: "MacRumors" },
  { url: "https://9to5mac.com/feed/", source: "9to5Mac" },
  { url: "https://9to5google.com/feed/", source: "9to5Google" },
  { url: "https://www.androidauthority.com/feed/", source: "Android Authority" },
  { url: "https://www.tomshardware.com/feeds/all", source: "Tom's Hardware" },
  // AnandTech returns malformed XML (attribute without value) — removed.

  // --- AI & Data Science ---
  { url: "https://news.mit.edu/topic/mitartificial-intelligence2-rss.xml", source: "MIT AI" },
  // OpenAI Blog returns 403 — removed.
  // { url: "https://openai.com/blog/rss/", source: "OpenAI Blog" },
  { url: "https://deepmind.google/blog/rss.xml", source: "DeepMind" },
  { url: "https://blogs.nvidia.com/feed/", source: "NVIDIA Blog" },

  // --- Science ---
  { url: "https://www.nasa.gov/rss/dyn/breaking_news.rss", source: "NASA" },
  { url: "https://www.newscientist.com/section/news/feed/", source: "New Scientist" },
  { url: "https://www.sciencedaily.com/rss/all.xml", source: "ScienceDaily" },
  { url: "https://phys.org/rss-feed/", source: "Phys.org" },
  { url: "https://www.space.com/feeds/all", source: "Space.com" },
  { url: "https://www.nature.com/nature.rss", source: "Nature" },

  // --- Business & Finance ---
  { url: "https://feeds.bloomberg.com/markets/news.rss", source: "Bloomberg" },
  { url: "https://www.ft.com/?format=rss", source: "Financial Times" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", source: "MarketWatch" },
  { url: "https://finance.yahoo.com/news/rssindex", source: "Yahoo Finance" },
  // Investopedia returns 403 — removed.
  // { url: "https://www.investopedia.com/feedbuilder/feed/getfeed?feedName=rss_headline", source: "Investopedia" },
  { url: "https://www.economist.com/latest/rss.xml", source: "The Economist" },

  // --- World / International ---
  { url: "https://www.aljazeera.com/xml/rss/all.xml", source: "Al Jazeera" },
  { url: "https://www.theguardian.com/world/rss", source: "The Guardian" },
  { url: "https://www.theguardian.com/uk/technology/rss", source: "Guardian Tech" },
  { url: "https://www.theguardian.com/science/rss", source: "Guardian Science" },
  { url: "https://www.independent.co.uk/news/world/rss", source: "The Independent" },
  { url: "https://www.telegraph.co.uk/news/rss.xml", source: "The Telegraph" },
  { url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", source: "Times of India" },
  { url: "https://www.scmp.com/rss/91/feed", source: "SCMP" },
  // NHK World returns 404 — removed.
  // { url: "https://www3.nhk.or.jp/nhkworld/en/news/feeds/", source: "NHK World" },
  { url: "https://www.france24.com/en/rss", source: "France 24" },
  // DW News returns 404 — removed.
  // { url: "https://www.dw.com/en/top-stories/rss-4547", source: "DW News" },

  // --- Dev & Programming ---
  { url: "https://dev.to/feed", source: "DEV.to" },
  { url: "https://hnrss.org/frontpage", source: "Hacker News" },
  // InfoQ returns 406 — removed.
  // GitHub Blog returns 404 — removed.
  { url: "https://stackoverflow.blog/feed/", source: "Stack Overflow Blog" },
  { url: "https://css-tricks.com/feed/", source: "CSS-Tricks" },
  { url: "https://www.smashingmagazine.com/feed/", source: "Smashing Magazine" },

  // --- Security ---
  { url: "https://krebsonsecurity.com/feed/", source: "Krebs on Security" },
  { url: "https://www.schneier.com/feed/atom/", source: "Schneier on Security" },
  { url: "https://www.bleepingcomputer.com/feed/", source: "BleepingComputer" },
  { url: "https://threatpost.com/feed/", source: "Threatpost" },

  // --- Startups & VC ---
  { url: "https://news.ycombinator.com/rss", source: "YC News" },
  { url: "https://www.producthunt.com/feed", source: "Product Hunt" },
  { url: "https://sifted.eu/feed", source: "Sifted" },

  // --- Misc / Lifestyle ---
  { url: "https://lifehacker.com/rss", source: "Lifehacker" },
  { url: "https://www.vice.com/en/rss", source: "VICE" },
  { url: "https://www.vox.com/rss/index.xml", source: "Vox" },
  { url: "https://slate.com/feeds/all.rss", source: "Slate" },
  { url: "https://www.theatlantic.com/feed/all/", source: "The Atlantic" },
];
