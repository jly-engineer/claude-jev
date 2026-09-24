import http from "node:http";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readEvents, aggregate } from "./ledger.mjs";
import { getUsageState } from "./usage-state.mjs";
import { session, resetSession, planTurn, commitTurn } from "./chat.mjs";
import { agentAvailable, newAgentSession, runAgentTurn, agentConfig } from "./agent.mjs";
import { TIER_NAMES, tierSpec } from "./config.mjs";
import { listSkills } from "./skills.mjs";
import { saveImage, pruneUploads, MAX_BYTES, UPLOAD_DIR } from "./uploads.mjs";
import { validChatId, loadChat, newChat, saveChat, listChats, deleteChat } from "./chats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(HERE, "web-dashboard.html");
const CHAT_PATH = join(HERE, "web-chat.html");
const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

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

    if (url.pathname === "/api/skills") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ skills: listSkills(agentConfig().cwd) }));
      return;
    }

    if (url.pathname === "/api/upload" && req.method === "POST") {
      // Raw bytes, not JSON: base64 in a JSON envelope inflates by a third and
      // the readJson limit is sized for messages, not screenshots.
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BYTES) { tooBig = true; req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (tooBig) {
          res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "image too large" }));
          return;
        }
        try {
          const saved = saveImage(Buffer.concat(chunks));
          pruneUploads();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ path: saved.path, name: saved.name, mime: saved.mime, bytes: saved.bytes }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
        }
      });
      req.on("error", () => { /* client went away */ });
      return;
    }

    if (url.pathname === "/api/chats" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ chats: listChats() }));
      return;
    }

    const chatPath = /^\/api\/chats\/([^/]+)$/.exec(url.pathname);
    if (chatPath) {
      const id = chatPath[1];
      const json = (status, body) =>
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
      if (!validChatId(id)) return json(400, { error: "invalid chat id" });
      if (req.method === "GET") {
        // A chat nobody has written to yet is simply empty: the page opens a
        // fresh id on every first visit.
        const chat = loadChat(id) ?? newChat(id);
        // Internal state (agent session, API history) stays server-side.
        return json(200, { id: chat.id, title: chat.title, created: chat.created, updated: chat.updated, messages: chat.messages });
      }
      if (req.method === "DELETE") {
        resetSession(id);
        return json(200, { ok: true, deleted: deleteChat(id) });
      }
      return json(405, { error: "method not allowed" });
    }

    // Pasted images, so a reopened chat can show them. Names are ones
    // saveImage() generated; anything else never reaches the filesystem.
    const upload = /^\/api\/uploads\/([a-z0-9]+-[0-9a-f]{12}\.(png|jpg|gif|webp))$/.exec(url.pathname);
    if (upload && req.method === "GET") {
      try {
        const bytes = readFileSync(join(UPLOAD_DIR, upload[1]));
        res.writeHead(200, { "Content-Type": MIME_BY_EXT["." + upload[2]], "Cache-Control": "private, max-age=86400" });
        res.end(bytes);
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "image no longer available" }));
      }
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
  // Paths returned by /api/upload. Never trusted as paths — only ones we
  // wrote ourselves, under the uploads directory, are honoured.
  const images = Array.isArray(payload.images)
    ? payload.images.filter((f) => typeof f === "string" && f.startsWith(UPLOAD_DIR)).slice(0, 8)
    : [];
  if (!text && images.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "empty message" }));
    return;
  }
  if (!backend) {
    res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({
      error: "Chat is unavailable: no `claude` CLI on PATH, and no ANTHROPIC_API_KEY for the direct API path.",
    }));
    return;
  }
  // The id names a file on disk, so it must be one of ours.
  if (!validChatId(id)) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid chat id" }));
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

  if (backend === "agent") await agentChat({ res, send, id, text, images, proxyPort, settingsFile });
  else await apiChat({ res, send, id, text, images, proxyPort });
}

/**
 * Headless Claude Code. It authenticates itself, so this is the path that
 * works on a Pro/Max subscription — we never see the credential. Jev routing
 * happens inside the proxy off the normal sentinel, because a real Claude Code
 * request carries tools and so survives extractPrompt().
 */
async function agentChat({ res, send, id, text, images, proxyPort, settingsFile }) {
  const chat = loadChat(id) ?? newChat(id);
  const s = session(id);
  // After a restart the in-memory session is new, but Claude Code still has
  // the conversation on disk: pick it up rather than starting over.
  if (!s.agentSession && chat.agentSession) {
    s.agentSession = chat.agentSession;
    s.agentStarted = chat.agentStarted;
  }
  s.agentSession ??= newAgentSession();

  // Saved before the turn runs, so a refresh mid-reply still shows the question.
  chat.backend = "agent";
  chat.agentSession = s.agentSession;
  chat.messages.push({ role: "user", text, images });
  saveChat(chat);
  const turn = newTurn();

  const cfg = agentConfig();
  send("backend", { backend: "agent", tools: cfg.tools, deny: cfg.deny, writable: cfg.writable, cwd: cfg.cwd, dirs: cfg.dirs });

  let announced = false;
  try {
    // The child takes a text prompt, so an image reaches it as a path it can
    // Read — the uploads directory is always in its --add-dir.
    // Must be an instruction, not a label. A bare "[image: <path>]" prefix
    // left the model answering from the filename alone — it described an
    // image it had never opened, with no tool call and no error. Naming the
    // Read tool explicitly is what actually makes it look.
    const prompt = images.length
      ? `Use the Read tool on ${images.length === 1 ? "this image file" : "each of these image files"}:\n` +
        images.map((f) => `- ${f}`).join("\n") +
        `\n\nThen answer, based only on what the ${images.length === 1 ? "image" : "images"} actually shows: ` +
        (text || "describe it.")
      : text;
    await runAgentTurn(
      { prompt, sessionId: s.agentSession, started: s.agentStarted, proxyPort, settingsFile },
      (ev) => {
        if (ev.kind === "routed") {
          if (announced) return;          // one badge per turn
          announced = true;
          turn.model = ev.model;
          turn.tier = tierOf(ev.model);
          send("routed", { model: ev.model, tier: turn.tier });
        } else if (ev.kind === "delta") {
          turn.text += ev.text;
          send("delta", { text: ev.text });
        } else if (ev.kind === "tool") {
          turn.tools++;
          send("tool", { name: ev.name });
        } else if (ev.kind === "denied") {
          const denial = { reason: ev.reason, name: ev.name, path: ev.path };
          turn.denied.push(denial);
          send("denied", denial);
        } else if (ev.kind === "failed") {
          turn.error = ev.error;
          send("failed", { error: ev.error });
        } else if (ev.kind === "done") send("done", { costUsd: ev.costUsd });
      },
    );
    s.agentStarted = true;
  } catch (err) {
    turn.error = err.message;
    send("failed", { error: err.message });
  }
  // Saved even if the browser went away mid-reply, so reopening shows it.
  chat.agentStarted = s.agentStarted;
  chat.messages.push(turn);
  saveChat(chat);
  res.end();
}

const newTurn = () => ({ role: "assistant", text: "", model: null, tier: null, tools: 0, denied: [], error: null });

/** Direct API call with an API key. Tier chosen here, since a toolless
 *  request would otherwise never be routed by the proxy. */
async function apiChat({ res, send, id, text, images, proxyPort }) {
  const chat = loadChat(id) ?? newChat(id);
  const s = session(id);
  // After a restart the in-memory history is empty; the saved copy is not.
  if (s.messages.length === 0 && chat.api) {
    s.messages = chat.api.messages;
    s.tier = chat.api.tier;
  }
  chat.backend = "api";
  chat.messages.push({ role: "user", text, images });
  saveChat(chat);
  const turn = newTurn();

  // Every exit — success, upstream error, network error — records the turn once.
  let finished = false;
  const finish = (error) => {
    if (finished) return;
    finished = true;
    if (error) {
      turn.error = error;
      send("failed", { error });
    }
    chat.api = { messages: s.messages, tier: s.tier };
    chat.messages.push(turn);
    saveChat(chat);
    res.end();
  };

  let plan;
  try {
    // The direct-API backend has no filesystem on the far end, so the saved
    // files are read back and sent as base64 content blocks.
    const inline = images.map((f) => ({
      mime: MIME_BY_EXT[extname(f).toLowerCase()] || "image/png",
      data: readFileSync(f).toString("base64"),
    }));
    plan = await planTurn(s, text, inline);
  } catch (err) {
    finish(err.message);
    return;
  }
  turn.model = plan.model;
  turn.tier = plan.tier;

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
        up.on("end", () => finish(`upstream ${up.statusCode}: ${errBody.slice(0, 400)}`));
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
              turn.text += evt.delta.text;
              send("delta", { text: evt.delta.text });
            } else if (evt.type === "message_delta" && evt.usage) {
              send("usage", { outputTokens: evt.usage.output_tokens ?? 0 });
            } else if (evt.type === "error") {
              turn.error = evt.error?.message ?? "stream error";
              send("failed", { error: turn.error });
            }
          } catch { /* partial frame */ }
        }
      });

      up.on("end", () => {
        commitTurn(s, text, answer);
        send("done", { tier: plan.tier });
        finish();
      });
    },
  );

  upstream.on("error", (err) => finish(err.message));
  upstream.end(body);
}

/** Map a concrete model id back to its tier name, for the badge. */
function tierOf(modelId) {
  for (const name of TIER_NAMES) if (tierSpec(name)?.id === modelId) return name;
  return "unknown";
}
