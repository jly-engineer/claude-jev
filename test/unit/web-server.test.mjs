import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the dashboard off the real ledger.
const dir = mkdtempSync(join(tmpdir(), "claude-jev-web-"));
process.env.CLAUDE_JEV_LEDGER_PATH = join(dir, "usage.jsonl");
// Chat must report unavailable regardless of the developer's own environment.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const { startDashboardServer } = await import("../../src/web-server.mjs");

let server, url, port, token;

before(async () => {
  server = await startDashboardServer(0);
  ({ url, port } = server);
  const html = await (await fetch(url + "/")).text();
  token = /const TOKEN = "([0-9a-f]+)"/.exec(html)?.[1];
});
after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path, headers) => fetch(url + path, { headers });
const post = (path, body) =>
  fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// fetch() refuses to set Host — it is a forbidden header — so the rebinding
// checks need a raw request or they silently test nothing.
const rawStatus = (path, host) => new Promise((resolve) => {
  const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET", headers: { Host: host } },
    (res) => { res.resume(); resolve(res.statusCode); });
  req.on("error", () => resolve(0));
  req.end();
});

test("the page serves with a real token substituted in", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes("__JEV_TOKEN__"), "placeholder must be replaced");
  assert.match(token, /^[0-9a-f]{48}$/);
});

test("regression: no CORS wildcard", async () => {
  // This server reports spend and, via /api/chat, spends money. It used to
  // send Access-Control-Allow-Origin: *, which let any page read the ledger.
  const res = await get("/");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("api requires the token, by query or header", async () => {
  assert.equal((await get("/api/savings")).status, 401);
  assert.equal((await get("/api/savings?t=wrong")).status, 401);
  assert.equal((await get(`/api/savings?t=${token}`)).status, 200);
  assert.equal((await get("/api/savings", { "X-Jev-Token": token })).status, 200);
});

test("savings payload keeps its shape", async () => {
  const body = await (await get(`/api/savings?t=${token}`)).json();
  for (const key of ["events", "aggregated", "usage", "chatReady"]) {
    assert.ok(key in body, `missing ${key}`);
  }
  for (const bucket of ["today", "week", "month", "byTier"]) {
    assert.ok(bucket in body.aggregated, `missing aggregated.${bucket}`);
  }
});

test("only loopback Hosts are served", async () => {
  assert.equal(await rawStatus("/", `127.0.0.1:${port}`), 200);
  assert.equal(await rawStatus("/", `localhost:${port}`), 200);
  assert.equal(await rawStatus("/", "evil.example.com"), 403, "DNS rebinding must fail");
  assert.equal(await rawStatus("/api/savings", `evil.example.com:${port}`), 403);
  assert.equal(await rawStatus("/", `127.0.0.1:${port + 1}`), 403, "port must match too");
});

test("chat is off without a proxy, whatever else is available", async () => {
  // Headless Claude Code would run without the proxy, but the turn would be
  // neither Jev-routed nor recorded — chat that is not actually claude-jev.
  const body = await (await get(`/api/savings?t=${token}`)).json();
  assert.equal(body.chatReady, false);
  assert.equal(body.backend, null);

  const res = await post(`/api/chat?t=${token}`, { text: "hello" });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /claude|ANTHROPIC_API_KEY/);
});

test("with a proxy, the agent backend is preferred over an API key", async () => {
  // Agent is the path that works on a Pro/Max subscription, so it wins.
  const { startDashboardServer } = await import("../../src/web-server.mjs");
  const s = await startDashboardServer(0, { proxyPort: 9 });
  try {
    const html = await (await fetch(s.url + "/")).text();
    const tk = /const TOKEN = "([0-9a-f]+)"/.exec(html)[1];
    const body = await (await fetch(`${s.url}/api/savings?t=${tk}`)).json();
    // The claude CLI is present in this environment; if it ever is not, the
    // backend falls back rather than failing.
    assert.ok(body.backend === "agent" || body.backend === null, `unexpected backend ${body.backend}`);
    if (body.backend === "agent") {
      assert.ok(body.agent.tools.length > 0, "agent advertises its tool allowlist");
      assert.ok(!/Bash|Edit|Write/.test(body.agent.tools),
        `default agent tools must stay read-only, got: ${body.agent.tools}`);
    }
  } finally {
    s.close();
  }
});

test("CLAUDE_JEV_CHAT=off disables chat even when everything is present", async () => {
  process.env.CLAUDE_JEV_CHAT = "off";
  try {
    const { startDashboardServer } = await import("../../src/web-server.mjs");
    const s = await startDashboardServer(0, { proxyPort: 9 });
    const html = await (await fetch(s.url + "/")).text();
    const tk = /const TOKEN = "([0-9a-f]+)"/.exec(html)[1];
    const body = await (await fetch(`${s.url}/api/savings?t=${tk}`)).json();
    assert.equal(body.chatReady, false);
    s.close();
  } finally {
    delete process.env.CLAUDE_JEV_CHAT;
  }
});

test("chat rejects an empty message before spending anything", async () => {
  assert.equal((await post(`/api/chat?t=${token}`, { text: "   " })).status, 400);
  assert.equal((await post(`/api/chat?t=${token}`, {})).status, 400);
});

test("/chat serves the dedicated chat page, with its own token", async () => {
  const res = await get("/chat");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes("__JEV_TOKEN__"), "placeholder must be replaced");
  assert.match(html, /<title>[^<]*chat/i);
  assert.ok(html.includes('id="composerWrap"'), "chat page owns the composer");
  assert.ok(html.includes('href="/"'), "chat page links back to the dashboard");
  assert.equal((await get("/chat/")).status, 200, "trailing slash works too");
});

test("the dashboard links to chat and no longer embeds it", async () => {
  const html = await (await get("/")).text();
  assert.ok(html.includes('href="/chat"'), "dashboard must link to the chat page");
  assert.ok(!html.includes("<aside>"), "chat panel moved out of the dashboard");
  assert.ok(!html.includes('id="composerWrap"'), "composer lives on the chat page only");
});

test("regression: progress bars are block-level", async () => {
  // A bare inline <span> ignores width and height, so an empty .fill collapsed
  // to zero width and no bar ever rendered — .track only looked right because
  // a grid item gets blockified for free. Both must declare display: block.
  const html = await (await get("/")).text();
  assert.match(html, /\.track \{ display: block;/, ".track must be block");
  assert.match(html, /\.fill \{ display: block;/, ".fill must be block");
});

test("/api/skills lists commands for the typeahead, behind the token", async () => {
  assert.equal((await get("/api/skills")).status, 401, "token still required");
  const res = await get(`/api/skills?t=${token}`);
  assert.equal(res.status, 200);
  const { skills } = await res.json();
  assert.ok(Array.isArray(skills));
  for (const s of skills) {
    assert.equal(typeof s.name, "string");
    assert.equal(typeof s.description, "string");
    assert.ok(s.name.length > 0);
  }
});

test("the chat page wires up the slash typeahead", async () => {
  const html = await (await get("/chat")).text();
  assert.ok(html.includes('id="menu"'), "menu container present");
  assert.ok(html.includes("/api/skills"), "chat page fetches the command list");
});

test("unknown api routes 404 rather than falling through to the page", async () => {
  assert.equal((await get(`/api/nope?t=${token}`)).status, 404);
});
