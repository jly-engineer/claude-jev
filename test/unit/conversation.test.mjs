import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationKey, touchConvo } from "../../src/proxy.mjs";

// The boilerplate every Claude Code session opens with. The old key was the
// first 80 characters of message zero, which is entirely inside this.
const BOILER = "You are Claude Code, Anthropic's official CLI for Claude. ".repeat(3);

const convo = (prompt, system = "sys") => ({ system, messages: [{ role: "user", content: BOILER + prompt }] });

test("regression: a shared 80-character prefix no longer collides", () => {
  const a = convo("fix the auth bug in login.ts");
  const b = convo("write tests for the parser");
  assert.equal(a.messages[0].content.slice(0, 80), b.messages[0].content.slice(0, 80), "premise: prefixes match");
  assert.notEqual(conversationKey(a), conversationKey(b), "but the keys must not");
});

test("the key is stable across turns as history grows", () => {
  const a = convo("fix the auth bug");
  const later = {
    system: "sys",
    messages: [a.messages[0], { role: "assistant", content: "ok" }, { role: "user", content: "now do X" }],
  };
  assert.equal(conversationKey(a), conversationKey(later));
});

test("the system prompt participates in the key", () => {
  const messages = convo("same prompt").messages;
  assert.notEqual(conversationKey({ system: "A", messages }), conversationKey({ system: "B", messages }));
});

test("metadata.user_id is preferred when present", () => {
  const messages = convo("anything").messages;
  assert.equal(conversationKey({ metadata: { user_id: "u1" }, messages }), "uid:u1");
  assert.notEqual(
    conversationKey({ metadata: { user_id: "u1" }, messages }),
    conversationKey({ metadata: { user_id: "u2" }, messages }),
  );
});

test("structured content hashes, and degenerate bodies fall back to anon", () => {
  assert.match(conversationKey({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }), /^msg:[0-9a-f]{40}$/);
  assert.equal(conversationKey({}), "anon");
  assert.equal(conversationKey({ messages: [] }), "anon");
});

test("a new conversation starts on the cheapest tier", () => {
  const m = new Map();
  assert.deepEqual(touchConvo(m, "fresh"), { tier: "haiku", lastApplied: null });
});

test("touchConvo returns the same state object on re-entry", () => {
  const m = new Map();
  const first = touchConvo(m, "k");
  first.tier = "opus";
  assert.equal(touchConvo(m, "k"), first, "must not reset a live conversation");
});

test("regression: eviction is by least-recently-used, not insertion order", () => {
  const m = new Map();
  touchConvo(m, "long-running").tier = "opus";
  for (let i = 0; i < 49; i++) touchConvo(m, `fill${i}`);
  assert.equal(m.size, 50, "capped");

  touchConvo(m, "long-running");        // used again, so it is the newest
  touchConvo(m, "overflow");            // forces one eviction

  assert.equal(m.get("long-running")?.tier, "opus", "the touched session must survive");
  assert.equal(m.has("fill0"), false, "the genuinely stale one goes instead");
  assert.equal(m.size, 50, "still capped");
});
