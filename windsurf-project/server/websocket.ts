/**
 * WHAT: WebSocket server — pushes new articles to connected clients in real-time.
 * WHY:  V4 used HTTP polling (client asks "any new articles?" every 10 seconds).
 *       Polling wastes bandwidth when nothing changed and adds up to 10s latency.
 *       WebSocket is a persistent two-way connection — the server pushes articles
 *       the instant they arrive from Kafka. Zero latency, zero wasted requests.
 * HOW:  Attaches a WebSocket server to the existing HTTP server (same port 3001).
 *       Exports broadcast() — called by the Kafka consumer whenever a new article
 *       is stored. Sends JSON messages to all connected clients.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { Article } from "../shared/types.js";

// The WebSocket server instance — created when attachWebSocket() is called.
let wss: WebSocketServer;

/**
 * attachWebSocket — Creates a WebSocket server and attaches it to the HTTP server.
 *
 * Called once from index.ts after app.listen(). Uses the same port (3001) as Express.
 * The `ws` library detects WebSocket upgrade requests and handles them separately
 * from normal HTTP requests — no conflicts with Express routes.
 */
export function attachWebSocket(server: Server): void {
  wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    console.log(`[ws] Client connected. Total: ${wss.clients.size}`);

    // Mark the socket as alive when it first connects.
    // The heartbeat system will flip this to false every 30 seconds.
    // If the client doesn't respond with a pong before the next ping, it's terminated.
    (ws as any).isAlive = true;

    // When the client responds to our ping, mark it alive again.
    ws.on("pong", () => {
      (ws as any).isAlive = true;
    });

    // Send a welcome message so the client knows the connection is live.
    ws.send(JSON.stringify({ type: "connected", clients: wss.clients.size }));

    ws.on("close", () => {
      console.log(`[ws] Client disconnected. Total: ${wss.clients.size}`);
    });

    ws.on("error", (err) => {
      console.error("[ws] Client error:", err.message);
    });
  });

  // --- Heartbeat: detect and terminate zombie connections ---
  // A WebSocket connection can die silently — the browser tab crashes, the user's
  // wifi drops, a NAT gateway times out the idle TCP connection. When this happens,
  // the server doesn't get a "close" event. The client stays in wss.clients forever,
  // and every broadcast() call tries to send to it and silently fails.
  //
  // The fix is a ping/pong heartbeat: every 30 seconds, ping all clients.
  // Browsers automatically respond to WebSocket pings with a pong frame.
  // If a client doesn't pong back before the next ping, we know it's a zombie and
  // terminate it. This is like a roll call — no response means you're removed from the list.
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!(ws as any).isAlive) {
        // This client didn't respond to the last ping — it's a zombie. Terminate it.
        // terminate() immediately destroys the connection without a close handshake.
        ws.terminate();
        return;
      }
      // Mark as not-alive before pinging. If the client responds (pong), the handler above
      // flips it back to true. If not, it stays false and gets terminated next interval.
      (ws as any).isAlive = false;
      ws.ping();
    });
  }, 30_000);

  console.log("[ws] WebSocket server attached to HTTP server.");
}

/**
 * broadcast — Sends a new article to ALL connected WebSocket clients.
 *
 * Called by the Kafka consumer (consumer.ts) after an article is successfully
 * stored in Redis + OpenSearch. The article is sent as a JSON string with
 * type: "new_article" so the client can distinguish it from other message types.
 */
export function broadcast(article: Article): void {
  if (!wss) return;

  const payload = JSON.stringify({ type: "new_article", article });
  let sent = 0;

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
      sent++;
    }
  });

  if (sent > 0) {
    console.log(`[ws] Broadcast "${article.title.slice(0, 50)}..." to ${sent} client(s)`);
  }
}
