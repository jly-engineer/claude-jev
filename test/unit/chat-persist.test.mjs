import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in `claude` that logs its arguments and replies in stream-json, so
// real chat turns run through the server with no network and no account.
const dir = mkdtempSync(join(tmpdir(), "claude-jev-persist-"));
const bin = join(dir, "bin");
const ARGS_LOG = join(dir, "args.log");
mkdirSync(bin);
writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ARGS_LOG)}, JSON.stringify(a) + "\\n");
const at = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
const id = at("--session-id") || at("--resume");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: id });
out({ type: "assistant", session_id: id, message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "echo: " + at("-p") }] } });
out({ type: "result", subtype: "success", is_error: false, session_id: id, total_cost_usd: 0.001 });
`);
chmodSync(join(bin, "claude"), 0o755);

process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.CLAUDE_JEV_CHAT_DIR = join(dir, "chats");
process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
process.env.CLAUDE_JEV_LEDGER_PATH = join(dir, "usage.jsonl");
process.env.CLAUDE_JEV_AGENT_CWD = dir;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const skip = process.platform === "win32";
const { startDashboardServer } = await import("../../src/web-server.mjs");

let server, token;
before(async () => {
  if (skip) return;
  server = await startDashboardServer(0, { proxyPort: 9 });
  token = /const TOKEN = "([0-9a-f]+)"/.exec(await (await fetch(server.url + "/chat")).text())[1];
});
after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method, path, body) =>
  fetch(`${server.url}${path}${path.includes("?") ? "&" : "?"}t=${token}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
const say = async (id, text) => (await call("POST", "/api/chat", { id, text })).text();
const argLines = () => readFileSync(ARGS_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a turn is saved and can be reopened", { skip }, async () => {
  const stream = await say("chat-persist01", "first question");
  assert.match(stream, /echo: first question/);

  const chat = await (await call("GET", "/api/chats/chat-persist01")).json();
  assert.equal(chat.title, "first question");
  assert.deepEqual(chat.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(chat.messages[1].text, "echo: first question");
  assert.equal(chat.messages[1].tier, "haiku");
  assert.ok(!("agentSession" in chat), "internal state is not sent to the page");

  const listed = (await (await call("GET", "/api/chats")).json()).chats;
  assert.deepEqual(listed.map((c) => c.id), ["chat-persist01"]);
});

test("regression: after a restart the chat continues the same conversation", { skip }, async () => {
  // In-memory state used to be the only copy, so a restart silently started
  // a new conversation. /api/chat/reset clears exactly that in-memory state.
  await call("POST", "/api/chat/reset", { id: "chat-persist01" });
  await say("chat-persist01", "second question");

  const [first, second] = argLines();
  const sessionOf = (a) => a[a.indexOf("--session-id") + 1];
  assert.ok(first.includes("--session-id"));
  assert.ok(second.includes("--resume"), "resumed, not restarted");
  assert.equal(second[second.indexOf("--resume") + 1], sessionOf(first));

  const chat = await (await call("GET", "/api/chats/chat-persist01")).json();
  assert.equal(chat.messages.length, 4);
});

test("deleting a chat removes it and its Claude Code transcript", { skip }, async () => {
  const [first] = argLines();
  const session = first[first.indexOf("--session-id") + 1];
  const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", "-tmp-somewhere");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${session}.jsonl`), "{}\n");

  const res = await call("DELETE", "/api/chats/chat-persist01");
  assert.deepEqual(await res.json(), { ok: true, deleted: true });
  assert.deepEqual((await (await call("GET", "/api/chats/chat-persist01")).json()).messages, [], "reads as empty");
  assert.equal(existsSync(join(project, `${session}.jsonl`)), false);
  assert.deepEqual((await (await call("GET", "/api/chats")).json()).chats, []);
});

test("chat ids are validated on every route", { skip }, async () => {
  assert.equal((await call("GET", "/api/chats/..%2F..%2Fetc")).status, 400);
  assert.equal((await call("DELETE", "/api/chats/not-a-chat")).status, 400);
  assert.equal((await call("POST", "/api/chat", { id: "../../x", text: "hi" })).status, 400);
  const fresh = await call("GET", "/api/chats/chat-nosuchchat");
  assert.equal(fresh.status, 200, "a new chat reads as empty, not as an error");
  assert.deepEqual((await fresh.json()).messages, []);
  assert.deepEqual((await (await call("GET", "/api/chats")).json()).chats.map((c) => c.id).includes("chat-nosuchchat"), false,
    "reading does not create a file");
});

test("the chat routes require the token", { skip }, async () => {
  assert.equal((await fetch(server.url + "/api/chats")).status, 401);
  assert.equal((await fetch(server.url + "/api/chats/chat-persist01", { method: "DELETE" })).status, 401);
  assert.equal((await fetch(server.url + "/api/uploads/abc-0123456789ab.png")).status, 401);
});

test("uploads are served only by the names saveImage generates", { skip }, async () => {
  assert.equal((await call("GET", "/api/uploads/..%2F..%2Fusage.jsonl")).status, 404);
  assert.equal((await call("GET", "/api/uploads/abc-0123456789ab.png")).status, 404, "well-formed but missing");
});
