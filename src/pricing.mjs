// Per-million-token pricing (USD). Source: Anthropic pricing page Sep 2026.
// Output tokens typically cost 5x input on Anthropic models.
const MODELS = {
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.00, label: "Haiku 4.5" },
  "claude-sonnet-5":           { input: 3.00, output: 15.00, label: "Sonnet 5" },
  "claude-opus-4-6":           { input: 15.00, output: 75.00, label: "Opus 4.6" },
};

// The model everything is compared against — "what if you ran it all on opus?"
export const BASELINE_MODEL = "claude-opus-4-6";

/**
 * Cost in USD for a given model and token counts.
 * Returns 0 for unknown models rather than throwing.
 */
export function cost(modelId, inputTokens, outputTokens) {
  const m = MODELS[modelId];
  if (!m) return 0;
  return (inputTokens * m.input + outputTokens * m.output) / 1_000_000;
}

/**
 * What the same request would have cost on the baseline model.
 */
export function baselineCost(inputTokens, outputTokens) {
  return cost(BASELINE_MODEL, inputTokens, outputTokens);
}

/**
 * Human-readable label for a model id.
 */
export function modelLabel(modelId) {
  return MODELS[modelId]?.label ?? modelId;
}
