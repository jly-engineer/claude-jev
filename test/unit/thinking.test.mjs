import { test } from "node:test";
import assert from "node:assert/strict";
import { stripThinkingHistory } from "../../src/proxy.mjs";

test("removes a thinking block and keeps the rest of the turn", () => {
  const body = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "yo" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ],
  };
  assert.equal(stripThinkingHistory(body), 1);
  assert.deepEqual(body.messages[1].content, [{ type: "text", text: "yo" }]);
});

test("counts redacted_thinking and drops an assistant turn left empty", () => {
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "redacted_thinking", data: "z" }] },
      { role: "user", content: "q" },
    ],
  };
  assert.equal(stripThinkingHistory(body), 1);
  // An assistant message with an empty content array is rejected by the API.
  assert.deepEqual(body.messages, [{ role: "user", content: "q" }]);
});

test("a tool_use survives, so its tool_result is never orphaned", () => {
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "tool_use", id: "1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
    ],
  };
  stripThinkingHistory(body);
  assert.equal(body.messages.length, 2, "pairing must stay intact");
  assert.deepEqual(body.messages[0].content, [{ type: "tool_use", id: "1", name: "Bash", input: {} }]);
});

test("string content and user turns are untouched", () => {
  const body = { messages: [{ role: "assistant", content: "plain string" }, { role: "user", content: "hi" }] };
  assert.equal(stripThinkingHistory(body), 0);
});

test("degenerate bodies return zero rather than throwing", () => {
  assert.equal(stripThinkingHistory({}), 0);
  assert.equal(stripThinkingHistory({ messages: null }), 0);
  assert.equal(stripThinkingHistory({ messages: [] }), 0);
});

test("the body is left alone when there is nothing to strip", () => {
  const body = { messages: [{ role: "assistant", content: [{ type: "text", text: "a" }] }] };
  const before = JSON.stringify(body);
  assert.equal(stripThinkingHistory(body), 0);
  assert.equal(JSON.stringify(body), before);
});
