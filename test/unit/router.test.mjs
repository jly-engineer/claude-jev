import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../../src/router.mjs";
import { THRESHOLDS } from "../../src/config.mjs";

// decide() is pure policy: no network, no Jev. These pin the fail-open
// contract that the whole wrapper rests on.

test("a confident answer is followed, including downward", () => {
  assert.deepEqual(decide({ jev: { choice: "haiku", confidence: 0.95 }, current: "sonnet" }),
    { tier: "haiku", reason: "jev" });
  assert.deepEqual(decide({ jev: { choice: "opus", confidence: 0.9 }, current: "haiku" }),
    { tier: "opus", reason: "jev" });
});

test("fail-open: a missing or malformed answer keeps the current tier", () => {
  assert.deepEqual(decide({ jev: null, current: "sonnet" }), { tier: "sonnet", reason: "jev-unavailable" });
  assert.deepEqual(decide({ jev: undefined, current: "opus" }), { tier: "opus", reason: "jev-unavailable" });
  assert.deepEqual(decide({ jev: { choice: "gpt-9", confidence: 0.99 }, current: "haiku" }),
    { tier: "haiku", reason: "jev-unavailable" });
});

test("low confidence never downgrades", () => {
  assert.deepEqual(decide({ jev: { choice: "haiku", confidence: 0.4 }, current: "opus" }),
    { tier: "opus", reason: "low-confidence-no-downgrade" });
});

test("low confidence caps an upgrade at the uncertainty ceiling", () => {
  assert.deepEqual(decide({ jev: { choice: "opus", confidence: 0.4 }, current: "haiku" }),
    { tier: "sonnet", reason: "low-confidence-capped" });
});

test("uncertainty resolves downward, never upward", () => {
  // A rejected proposal would have escalated sonnet to opus below 0.3 while
  // the cap above demoted opus to sonnet at the same confidence. Pin the
  // direction so the contradiction cannot be reintroduced unnoticed.
  const low = 0.25;
  assert.ok(low < THRESHOLDS.minConfidence, "premise: this is a low-confidence case");
  assert.equal(decide({ jev: { choice: "sonnet", confidence: low }, current: "haiku" }).tier, "sonnet",
    "an uncertain sonnet must not become opus");
  assert.equal(decide({ jev: { choice: "opus", confidence: low }, current: "haiku" }).tier, "sonnet",
    "an uncertain opus is capped down to sonnet");
});

test("the ceiling never forces a downgrade below the current tier", () => {
  assert.deepEqual(decide({ jev: { choice: "opus", confidence: 0.4 }, current: "opus" }),
    { tier: "opus", reason: "jev" });
});

test("confidence exactly at the threshold is treated as confident", () => {
  assert.deepEqual(decide({ jev: { choice: "opus", confidence: THRESHOLDS.minConfidence }, current: "haiku" }),
    { tier: "opus", reason: "jev" });
});
