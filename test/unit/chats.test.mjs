import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "claude-jev-chats-"));
process.env.CLAUDE_JEV_CHAT_DIR = join(dir, "chats");
process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
after(() => rmSync(dir, { recursive: true, force: true }));

const { validChatId, newChat, saveChat, loadChat, listChats, deleteChat, deleteAgentTranscript } =
  await import("../../src/chats.mjs");

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("regression: ids that could escape the chat directory are refused", () => {
  // The id comes from the browser and becomes a filename.
  for (const bad of ["../../etc/passwd", "chat-../x", "chat-ABC123", "chat-", "chat-a/b", "", null, undefined, 42]) {
    assert.equal(validChatId(bad), false, String(bad));
    assert.equal(loadChat(bad), null);
    assert.equal(deleteChat(bad), false);
  }
  assert.throws(() => saveChat({ id: "../evil", messages: [] }), /invalid chat id/);
  assert.equal(validChatId("chat-abc123"), true);
});

test("a chat round-trips, titled from its first message", () => {
  const chat = newChat("chat-roundtrip1");
  chat.messages.push({ role: "user", text: "  How do I   rotate the logs?  ", images: [] });
  chat.messages.push({ role: "assistant", text: "Use logrotate.", model: "m", tier: "haiku", tools: 0, denied: [], error: null });
  saveChat(chat);
  const back = loadChat("chat-roundtrip1");
  assert.equal(back.title, "How do I rotate the logs?");
  assert.equal(back.messages.length, 2);
  assert.equal(readdirSync(process.env.CLAUDE_JEV_CHAT_DIR).filter((f) => f.endsWith(".tmp")).length, 0, "no temp file left");
});

test("titles are capped, and an image-only first message is titled as such", () => {
  const long = newChat("chat-longtitle");
  long.messages.push({ role: "user", text: "x".repeat(300), images: [] });
  assert.ok(saveChat(long).title.length <= 80);

  const img = newChat("chat-imageonly");
  img.messages.push({ role: "user", text: "", images: ["/tmp/a.png"] });
  assert.equal(saveChat(img).title, "(image)");
});

test("the list is most recent first and skips files that are not chats", async () => {
  mkdirSync(process.env.CLAUDE_JEV_CHAT_DIR, { recursive: true });
  writeFileSync(join(process.env.CLAUDE_JEV_CHAT_DIR, "notes.txt"), "x");
  writeFileSync(join(process.env.CLAUDE_JEV_CHAT_DIR, "chat-corrupt1.json"), "{not json");

  const older = newChat("chat-older01");
  older.messages.push({ role: "user", text: "older", images: [] });
  saveChat(older);
  await new Promise((r) => setTimeout(r, 5));
  const newer = newChat("chat-newer01");
  newer.messages.push({ role: "user", text: "newer", images: [] });
  saveChat(newer);

  const ids = listChats().map((c) => c.id);
  assert.ok(ids.indexOf("chat-newer01") < ids.indexOf("chat-older01"));
  assert.ok(!ids.includes("chat-corrupt1"));
  assert.equal(listChats().find((c) => c.id === "chat-newer01").turns, 1);
});

test("deleting a chat also deletes Claude Code's saved conversation", () => {
  const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", "-home-someone-somewhere");
  mkdirSync(join(project, SESSION), { recursive: true });
  writeFileSync(join(project, `${SESSION}.jsonl`), "{}\n");
  const other = join(project, "11111111-2222-4333-8444-555555555555.jsonl");
  writeFileSync(other, "{}\n");

  const chat = newChat("chat-withagent");
  chat.agentSession = SESSION;
  chat.messages.push({ role: "user", text: "hi", images: [] });
  saveChat(chat);

  assert.equal(deleteChat("chat-withagent"), true);
  assert.equal(loadChat("chat-withagent"), null);
  assert.equal(existsSync(join(project, `${SESSION}.jsonl`)), false);
  assert.equal(existsSync(join(project, SESSION)), false, "its subagent directory too");
  assert.equal(existsSync(other), true, "other conversations are untouched");
  assert.equal(deleteChat("chat-withagent"), false, "already gone");
});

test("only a well-formed session id is ever used to delete", () => {
  assert.equal(deleteAgentTranscript("../../../etc"), 0);
  assert.equal(deleteAgentTranscript("*"), 0);
  assert.equal(deleteAgentTranscript(undefined), 0);
});
