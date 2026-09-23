import { test } from "node:test";
import assert from "node:assert/strict";
import { cost, baselineCost, totalInputTokens, isPriced, BASELINE_MODEL } from "../../src/pricing.mjs";

const HAIKU_DATED = "claude-haiku-4-5-20251001";
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: got ${a}, want ${b}`);
const MTOK = 1_000_000;

test("dated and bare model ids price identically", () => {
  near(cost(HAIKU_DATED, { inputTokens: MTOK }), 1.0, "dated haiku input");
  near(cost("claude-haiku-4-5", { inputTokens: MTOK }), 1.0, "bare haiku input");
});

test("per-model base rates", () => {
  near(cost(HAIKU_DATED, { outputTokens: MTOK }), 5.0, "haiku output");
  near(cost("claude-sonnet-5", { inputTokens: MTOK, outputTokens: MTOK }), 12.0, "sonnet 2 + 10");
  near(cost("claude-opus-4-6", { inputTokens: MTOK, outputTokens: MTOK }), 30.0, "opus 4.6 5 + 25");
  near(cost("claude-opus-5", { inputTokens: MTOK, outputTokens: MTOK }), 30.0, "opus 5 5 + 25");
});

test("cache tokens bill at their own multiples of the input rate", () => {
  near(cost(HAIKU_DATED, { cacheReadTokens: MTOK }), 0.10, "read is 0.1x");
  near(cost(HAIKU_DATED, { cacheWrite5mTokens: MTOK }), 1.25, "5m write is 1.25x");
  near(cost(HAIKU_DATED, { cacheWrite1hTokens: MTOK }), 2.00, "1h write is 2x");
});

test("an unpriced model is costed at baseline rates, never zero", () => {
  assert.equal(isPriced("some-finetune"), false);
  assert.ok(cost("some-finetune", { inputTokens: MTOK }) > 0, "must not be free");
  near(cost("some-finetune", { inputTokens: MTOK }), cost(BASELINE_MODEL, { inputTokens: MTOK }), "baseline rates");
});

test("known models report as priced", () => {
  assert.equal(isPriced(HAIKU_DATED), true);
  assert.equal(isPriced("claude-sonnet-5"), true);
  assert.equal(isPriced(BASELINE_MODEL), true);
});

test("totalInputTokens counts cache tokens as billed input", () => {
  const u = { inputTokens: 4, outputTokens: 850, cacheWrite5mTokens: 12000, cacheReadTokens: 80000 };
  assert.equal(totalInputTokens(u), 92004);
  assert.equal(totalInputTokens({}), 0);
});

test("baselineCost prices the same usage on the baseline model", () => {
  const u = { inputTokens: 500, outputTokens: 900, cacheReadTokens: 40000 };
  assert.equal(baselineCost(u), cost(BASELINE_MODEL, u));
});

test("regression: a cache-heavy turn costs far more than its uncached slice", () => {
  // The bug this guards: pricing only usage.input_tokens understated a typical
  // Claude Code turn by roughly 6x, and understated it unevenly against the
  // baseline, so the savings percentage itself came out wrong.
  const real = { inputTokens: 4, outputTokens: 850, cacheWrite5mTokens: 12000, cacheReadTokens: 80000 };
  const full = cost(HAIKU_DATED, real);
  const uncachedOnly = cost(HAIKU_DATED, { inputTokens: real.inputTokens, outputTokens: real.outputTokens });
  assert.ok(full > uncachedOnly * 5, `cache tokens must dominate: ${full} vs ${uncachedOnly}`);
  assert.ok(baselineCost(real) > full, "opus baseline must exceed haiku actual");
});
