import http from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readEvents, aggregate } from "./ledger.mjs";
import { getUsageState } from "./usage-state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(HERE, "web-dashboard.html");

/**
 * Start the web dashboard server. Returns { port, close, url }.
 */
export async function startDashboardServer(preferredPort = 0) {
  const html = readFileSync(HTML_PATH, "utf8");

  const server = http.createServer((req, res) => {
    // CORS for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.url === "/api/savings" || req.url?.startsWith("/api/savings?")) {
      const events = readEvents(30);
      const aggregated = aggregate(events);
      const usage = getUsageState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ events, aggregated, usage }));
      return;
    }

    // Serve the dashboard HTML for everything else
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  return new Promise((resolve) => {
    server.listen(preferredPort, "127.0.0.1", () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}`;
      resolve({ port, url, close: () => server.close() });
    });
  });
}
