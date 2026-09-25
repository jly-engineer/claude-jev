import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, mergeUsage } from "../../src/proxy.mjs";
import {
  captureFromHeaders,
  captureFromRateLimitEvent,
  getUsageState,
  resetUsageState,
} from "../../src/usage-state.mjs";

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

// --- unified cap windows -----------------------------------------------

const SEC = 1000;

test("a window whose reset time has passed reads as rolled over, not as the old value", () => {
  resetUsageState();
  const now = Date.now();
  captureFromRateLimitEvent({
    unifiedWindows: {
      five_hour: { utilization: 0.87, resetsAt: Math.floor(now / SEC) + 60 },
      seven_day: { utilization: 0.4, resetsAt: Math.floor(now / SEC) + 86400 },
    },
  });

  assert.equal(getUsageState(now).fiveHour.utilization, 0.87, "still inside the window");

  const after = now + 61 * SEC;
  assert.equal(getUsageState(after).fiveHour.utilization, 0, "window rolled over, quota is fresh");
  assert.equal(getUsageState(after).fiveHour.resetAt, null, "the expired reset time is not shown");
  assert.equal(getUsageState(after).sevenDay.utilization, 0.4, "the weekly window is untouched");
});

test("an idle process ages the cap out instead of serving it until restart", () => {
  resetUsageState();
  const now = Date.now();
  captureFromHeaders({
    "anthropic-ratelimit-unified-5h-utilization": "0.95",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(now / SEC) + 300),
    "anthropic-ratelimit-unified-5h-status": "allowed",
  });
  const sixHoursLater = now + 6 * 60 * 60 * SEC;
  assert.equal(getUsageState(sixHoursLater).fiveHour.utilization, 0);
});

test("a window with no reset time is left alone rather than expired", () => {
  resetUsageState();
  const now = Date.now();
  captureFromRateLimitEvent({ unifiedWindows: { five_hour: { utilization: 0.2 } } });
  assert.equal(getUsageState(now + 99 * 24 * 60 * 60 * SEC).fiveHour.utilization, 0.2);
});

test("an unparseable header is dropped, since NaN would paint a broken gauge", () => {
  resetUsageState();
  captureFromHeaders({
    "anthropic-ratelimit-unified-5h-utilization": "not-a-number",
    "anthropic-ratelimit-unified-5h-reset": "also-nonsense",
  });
  assert.equal(getUsageState().fiveHour.utilization, null);

  captureFromHeaders({
    "anthropic-ratelimit-unified-7d-utilization": "0.5",
    "anthropic-ratelimit-unified-7d-reset": "garbage",
  });
  assert.equal(getUsageState().sevenDay.utilization, 0.5);
  assert.equal(getUsageState().sevenDay.resetAt, null, "a bad reset must not become NaN");
});

test("callers cannot mutate the stored windows through the returned snapshot", () => {
  resetUsageState();
  captureFromRateLimitEvent({ unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: 9e9 } } });
  getUsageState().fiveHour.utilization = 0.99;
  assert.equal(getUsageState().fiveHour.utilization, 0.3);
});
