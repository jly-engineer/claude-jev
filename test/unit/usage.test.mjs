import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, mergeUsage } from "../../src/proxy.mjs";

test("a realistic stream: message_start carries input and cache, message_delta carries output", () => {
  const u = emptyUsage();
  mergeUsage(u, {
    input_tokens: 4,
    cache_creation_input_tokens: 12000,
    cache_read_input_tokens: 80000,
    output_tokens: 1,
  });
  mergeUsage(u, { output_tokens: 850 });
  assert.deepEqual(u, {
    inputTokens: 4,
    outputTokens: 850,
    cacheWrite5mTokens: 12000,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 80000,
  });
});

test("counts are cumulative per response, so they are assigned and not summed", () => {
  const u = emptyUsage();
  mergeUsage(u, { output_tokens: 100 });
  mergeUsage(u, { output_tokens: 250 });
  mergeUsage(u, { output_tokens: 400 });
  assert.equal(u.outputTokens, 400, "summing would give 750 and overbill every response");
});

test("per-TTL cache breakdown wins over the aggregate, since 5m and 1h bill differently", () => {
  const u = emptyUsage();
  mergeUsage(u, {
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 3000 },
    cache_creation_input_tokens: 4000,
  });
  assert.equal(u.cacheWrite5mTokens, 1000);
  assert.equal(u.cacheWrite1hTokens, 3000);
});

test("the aggregate is used when no breakdown is present, priced as 5m", () => {
  const u = emptyUsage();
  mergeUsage(u, { cache_creation_input_tokens: 4000 });
  assert.equal(u.cacheWrite5mTokens, 4000);
  assert.equal(u.cacheWrite1hTokens, 0);
});

test("a later event does not clobber fields it does not report", () => {
  const u = emptyUsage();
  mergeUsage(u, { input_tokens: 500, cache_read_input_tokens: 9000 });
  mergeUsage(u, { output_tokens: 20 });
  assert.deepEqual(u, {
    inputTokens: 500,
    outputTokens: 20,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 9000,
  });
});

test("a missing or non-object usage is a no-op", () => {
  const u = emptyUsage();
  const before = { ...u };
  assert.deepEqual(mergeUsage(u, null), before);
  assert.deepEqual(mergeUsage(u, undefined), before);
  assert.deepEqual(mergeUsage(u, "nonsense"), before);
});

test("non-streaming message events populate both sides at once", () => {
  const u = emptyUsage();
  mergeUsage(u, { input_tokens: 700, output_tokens: 120, cache_read_input_tokens: 3000 });
  assert.equal(u.inputTokens, 700);
  assert.equal(u.outputTokens, 120);
  assert.equal(u.cacheReadTokens, 3000);
});
