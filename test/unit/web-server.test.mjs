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

test("chat is disabled without a proxy and a key, and says why", async () => {
  const body = await (await get(`/api/savings?t=${token}`)).json();
  assert.equal(body.chatReady, false);

  const res = await post(`/api/chat?t=${token}`, { text: "hello" });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /ANTHROPIC_API_KEY/);
});

test("chat rejects an empty message before spending anything", async () => {
  assert.equal((await post(`/api/chat?t=${token}`, { text: "   " })).status, 400);
  assert.equal((await post(`/api/chat?t=${token}`, {})).status, 400);
});

test("unknown api routes 404 rather than falling through to the page", async () => {
  assert.equal((await get(`/api/nope?t=${token}`)).status, 404);
});
