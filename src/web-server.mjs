import http from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readEvents, aggregate } from "./ledger.mjs";
import { getUsageState } from "./usage-state.mjs";
import { session, resetSession, planTurn, commitTurn } from "./chat.mjs";
import { agentAvailable, newAgentSession, runAgentTurn, agentConfig } from "./agent.mjs";
import { TIER_NAMES, tierSpec } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(HERE, "web-dashboard.html");
const CHAT_PATH = join(HERE, "web-chat.html");

/**
 * Per-process token, embedded in the page and required on every /api call.
 *
 * The dashboard reports spend and, through /api/chat, spends money. It used
 * to answer any origin (`Access-Control-Allow-Origin: *`) with no Host check,
 * so any page open in the browser could read the ledger — and, once chat
 * exists, run up the API bill. Same-origin is enforced three ways now: no
 * CORS header at all, a Host allowlist against DNS rebinding, and this token.
 */
const TOKEN = randomBytes(24).toString("hex");

/** Only loopback Hosts. A rebound DNS name resolving to 127.0.0.1 fails here. */
function hostAllowed(req, port) {
  const host = (req.headers.host ?? "").toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Start the web dashboard server.
 *
 * @param {number} preferredPort
 * @param {object} [opts]
 * @param {number} [opts.proxyPort] local proxy port — chat is disabled without it
 */
export async function startDashboardServer(preferredPort = 0, opts = {}) {
  const template = readFileSync(HTML_PATH, "utf8");
  const chatTemplate = readFileSync(CHAT_PATH, "utf8");
  const { proxyPort } = opts;
  let port = preferredPort;

  // Two chat backends. "agent" spawns headless Claude Code, which
  // authenticates itself — so a Pro/Max subscription works and we never touch
  // the credential. "api" talks to the proxy directly and needs an API key.
  // Agent wins when available, since it is the one that works on a
  // subscription. Force either with CLAUDE_JEV_CHAT=agent|api|off.
  const forced = (process.env.CLAUDE_JEV_CHAT || "").toLowerCase();
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  //
  // Both backends require the proxy. Headless Claude Code would happily run
  // without it, but then the turn is neither routed by Jev nor recorded in
  // the ledger — chat that silently skips the whole point of the tool and
  // never shows up in the numbers beside it. Better to offer no chat and say
  // why than to offer a chat that quietly is not claude-jev.
  const backend =
    !proxyPort || forced === "off" ? null
    : forced === "api" ? (hasKey ? "api" : null)
    : forced === "agent" ? (agentAvailable() ? "agent" : null)
    : agentAvailable() ? "agent"
    : hasKey ? "api"
    : null;
  const chatReady = Boolean(backend);

  const server = http.createServer(async (req, res) => {
    if (!hostAllowed(req, port)) {
      res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
      return;
    }
    // No Access-Control-Allow-Origin: this server is same-origin only.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const isApi = url.pathname.startsWith("/api/");

    if (isApi && url.searchParams.get("t") !== TOKEN && req.headers["x-jev-token"] !== TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad token" }));
      return;
    }

    if (url.pathname === "/api/savings") {
      const events = readEvents(30);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        events,
        aggregated: aggregate(events),
        usage: getUsageState(),
        chatReady,
        backend,
        agent: backend === "agent" ? agentConfig() : null,
      }));
      return;
    }

    if (url.pathname === "/api/chat/reset" && req.method === "POST") {
      const { id = "default" } = await readJson(req).catch(() => ({}));
      resetSession(id);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      await handleChat(req, res, { proxyPort, backend, settingsFile: opts.settingsFile });
      return;
    }

    if (isApi) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }

    const page = url.pathname === "/chat" || url.pathname === "/chat/" ? chatTemplate : template;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page.replace("__JEV_TOKEN__", TOKEN));
  });

  return new Promise((resolve, reject) => {
    const onListen = () => {
      port = server.address().port;
      server.removeListener("error", onEarlyError);
      server.on("error", () => { /* keep the dashboard alive on late socket errors */ });
      resolve({ port, url: `http://127.0.0.1:${port}`, close: () => server.close() });
    };
    // Detached once listening, so a later runtime error cannot re-settle this.
    const onEarlyError = (err) => {
      if (err.code === "EADDRINUSE" && preferredPort !== 0) {
        server.listen(0, "127.0.0.1", onListen);   // another session has 3579
      } else {
        reject(err);
      }
    };
    server.on("error", onEarlyError);
    server.listen(preferredPort, "127.0.0.1", onListen);
  });
}

/**
 * Route one chat turn and stream the reply back as SSE.
 *
 * Either backend goes through the local proxy, so the ledger, the savings
 * figures and the usage gauges all see chat traffic too.
 */
async function handleChat(req, res, { proxyPort, backend, settingsFile }) {
  let payload;
  try {
    payload = await readJson(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad request" }));
    return;
  }

  const text = String(payload.text ?? "").trim();
  const id = String(payload.id ?? "default");
  if (!text) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "empty message" }));
    return;
  }
  if (!backend) {
    res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({
      error: "Chat is unavailable: no `claude` CLI on PATH, and no ANTHROPIC_API_KEY for the direct API path.",
    }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  const send = (event, data) => res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);

  if (backend === "agent") await agentChat({ res, send, id, text, proxyPort, settingsFile });
  else await apiChat({ res, send, id, text, proxyPort });
}

/**
 * Headless Claude Code. It authenticates itself, so this is the path that
 * works on a Pro/Max subscription — we never see the credential. Jev routing
 * happens inside the proxy off the normal sentinel, because a real Claude Code
 * request carries tools and so survives extractPrompt().
 */
async function agentChat({ res, send, id, text, proxyPort, settingsFile }) {
  const s = session(id);
  s.agentSession ??= newAgentSession();

  send("backend", { backend: "agent", tools: agentConfig().tools, cwd: agentConfig().cwd });

  let announced = false;
  try {
    await runAgentTurn(
      { prompt: text, sessionId: s.agentSession, started: s.agentStarted, proxyPort, settingsFile },
      (ev) => {
        if (ev.kind === "routed") {
          if (announced) return;          // one badge per turn
          announced = true;
          send("routed", { model: ev.model, tier: tierOf(ev.model) });
        } else if (ev.kind === "delta") send("delta", { text: ev.text });
        else if (ev.kind === "tool") send("tool", { name: ev.name });
        else if (ev.kind === "failed") send("failed", { error: ev.error });
        else if (ev.kind === "done") send("done", { costUsd: ev.costUsd });
      },
    );
    s.agentStarted = true;
  } catch (err) {
    send("failed", { error: err.message });
  }
  res.end();
}

/** Direct API call with an API key. Tier chosen here, since a toolless
 *  request would otherwise never be routed by the proxy. */
async function apiChat({ res, send, id, text, proxyPort }) {
  const s = session(id);
  let plan;
  try {
    plan = await planTurn(s, text);
  } catch (err) {
    send("failed", { error: err.message });
    res.end();
    return;
  }

  send("backend", { backend: "api" });
  send("routed", {
    tier: plan.tier, previous: plan.previous, model: plan.model,
    confidence: plan.confidence, reason: plan.reason, ms: plan.ms,
  });

  const body = Buffer.from(JSON.stringify(plan.body));
  const headers = {
    "content-type": "application/json",
    "content-length": body.length,
    "anthropic-version": "2023-06-01",
    accept: "text/event-stream",
  };
  if (process.env.ANTHROPIC_API_KEY) headers["x-api-key"] = process.env.ANTHROPIC_API_KEY;
  else headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;

  let answer = "";
  const upstream = http.request(
    { hostname: "127.0.0.1", port: proxyPort, path: "/v1/messages", method: "POST", headers },
    (up) => {
      if (up.statusCode !== 200) {
        let errBody = "";
        up.on("data", (c) => { errBody += c; });
        up.on("end", () => {
          send("failed", { error: `upstream ${up.statusCode}: ${errBody.slice(0, 400)}` });
          res.end();
        });
        return;
      }

      let buf = "";
      up.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
              answer += evt.delta.text;
              send("delta", { text: evt.delta.text });
            } else if (evt.type === "message_delta" && evt.usage) {
              send("usage", { outputTokens: evt.usage.output_tokens ?? 0 });
            } else if (evt.type === "error") {
              send("failed", { error: evt.error?.message ?? "stream error" });
            }
          } catch { /* partial frame */ }
        }
      });

      up.on("end", () => {
        commitTurn(s, text, answer);
        send("done", { tier: plan.tier });
        res.end();
      });
    },
  );

  upstream.on("error", (err) => {
    send("failed", { error: err.message });
    res.end();
  });
  upstream.end(body);
}

/** Map a concrete model id back to its tier name, for the badge. */
function tierOf(modelId) {
  for (const name of TIER_NAMES) if (tierSpec(name)?.id === modelId) return name;
  return "unknown";
}
