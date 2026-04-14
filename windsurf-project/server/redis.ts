/**
 * WHAT: Redis client connection setup — creates and exports a single Redis client instance.
 * WHY:  Redis runs as a separate process (like a mini database server). Our Node.js app needs
 *       a "client" to talk to it, just like a browser needs an HTTP client to talk to a web server.
 *       We create ONE client and reuse it everywhere — opening a new connection for every operation
 *       would be wasteful (each connection has overhead: TCP handshake, authentication, etc.).
 * HOW:  Imported by store.ts to read/write articles. The client connects to localhost:6379
 *       (Redis's default port). We listen for connection events so we know if Redis is up or down.
 */

// ioredis is the most popular Redis client for Node.js. It handles:
// - Connection management (auto-reconnect if Redis restarts)
// - Command pipelining (sending multiple commands efficiently)
// - TypeScript support out of the box
// We chose ioredis over the older "redis" package because it's more feature-rich and has better types.
import Redis from "ioredis";

// Create the Redis client. By default, it connects to localhost:6379.
// In production, you'd pass a connection URL or config object with host/port/password.
// For local development, the defaults are perfect — Redis is running right on your machine.
const redis = new Redis({
  // localhost = "this machine". 6379 is the default Redis port.
  // You started Redis with `brew services start redis`, which listens on this address.
  host: "127.0.0.1",
  port: 6379,

  // maxRetriesPerRequest: null tells ioredis to keep retrying forever if Redis is temporarily down.
  // Without this, ioredis gives up after 20 retries and throws an error.
  // For a learning project, we want resilience — if Redis hiccups, we wait and retry.
  maxRetriesPerRequest: null,
});

// --- Connection Event Listeners ---
// These are like console.log "probes" that tell us what's happening with the Redis connection.
// In V6, we'll replace these with Prometheus metrics.

// "connect" fires when the TCP connection is established (but before Redis is ready for commands).
redis.on("connect", () => {
  console.log("[redis] Connecting to Redis...");
});

// "ready" fires when Redis is fully ready to accept commands. This is the "all good" signal.
redis.on("ready", () => {
  console.log("[redis] Connected and ready on localhost:6379");
});

// "error" fires on any connection error. We log it but don't crash — ioredis auto-reconnects.
redis.on("error", (err) => {
  console.error("[redis] Connection error:", err.message);
});

// "close" fires when the connection is closed (Redis stopped, network issue, etc.).
redis.on("close", () => {
  console.log("[redis] Connection closed");
});

// Export the client so store.ts can use it.
// This is the "single source of truth" for the Redis connection — no other file creates its own client.
export default redis;
