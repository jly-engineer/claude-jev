// Per-million-token pricing (USD). Source: Anthropic pricing page, Sep 2026.
//
// Keys are un-suffixed model ids. Dated ids (claude-haiku-4-5-20251001) are
// normalized before lookup, so both spellings price the same.
const MODELS = {
  "claude-haiku-4-5": { input: 1.00, output: 5.00, label: "Haiku 4.5" },
  "claude-sonnet-5":  { input: 2.00, output: 10.00, label: "Sonnet 5" },
  "claude-sonnet-4-6": { input: 3.00, output: 15.00, label: "Sonnet 4.6" },
  "claude-opus-4-6":  { input: 5.00, output: 25.00, label: "Opus 4.6" },
  "claude-opus-4-7":  { input: 5.00, output: 25.00, label: "Opus 4.7" },
  "claude-opus-4-8":  { input: 5.00, output: 25.00, label: "Opus 4.8" },
  "claude-opus-5":    { input: 5.00, output: 25.00, label: "Opus 5" },
};

/**
 * Cache token rates, as multiples of a model's base input rate.
 * A cache write costs more than fresh input; a cache read costs a tenth.
 */
export const CACHE_MULTIPLIERS = {
  write5m: 1.25,
  write1h: 2.00,
  read: 0.10,
};

// The model everything is compared against — "what if you ran it all on opus?"
export const BASELINE_MODEL = "claude-opus-4-6";

/** Strip a trailing -YYYYMMDD date suffix so dated ids resolve. */
const normalize = (modelId) => String(modelId ?? "").replace(/-\d{8}$/, "");

function rates(modelId) {
  return MODELS[modelId] ?? MODELS[normalize(modelId)] ?? null;
}

/**
 * Whether this model has real pricing, or will be costed at baseline rates.
 * Record it on the event so a tier override does not quietly become $0.
 */
export function isPriced(modelId) {
  return rates(modelId) !== null;
}

/**
 * Cost in USD for a model and a usage breakdown.
 *
 * `usage` mirrors the API's own `usage` object, in tokens:
 *   inputTokens          - uncached input (full rate)
 *   cacheWrite5mTokens   - written to the 5-minute cache (1.25x input)
 *   cacheWrite1hTokens   - written to the 1-hour cache (2x input)
 *   cacheReadTokens      - served from cache (0.1x input)
 *   outputTokens         - generated (output rate)
 *
 * An unknown model is costed at baseline rates rather than zero — a silent
 * $0 understates spend and inflates the savings figure.
 */
export function cost(modelId, usage = {}) {
  const m = rates(modelId) ?? rates(BASELINE_MODEL);
  const {
    inputTokens = 0,
    outputTokens = 0,
    cacheWrite5mTokens = 0,
    cacheWrite1hTokens = 0,
    cacheReadTokens = 0,
  } = usage;

  return (
    inputTokens * m.input +
    cacheWrite5mTokens * m.input * CACHE_MULTIPLIERS.write5m +
    cacheWrite1hTokens * m.input * CACHE_MULTIPLIERS.write1h +
    cacheReadTokens * m.input * CACHE_MULTIPLIERS.read +
    outputTokens * m.output
  ) / 1_000_000;
}

/**
 * What the same usage would have cost on the baseline model.
 *
 * Cache tokens are priced with the same multipliers: the comparison is
 * "same conversation, same cache behaviour, bigger model" — the baseline run
 * would have written and read the same cache.
 */
export function baselineCost(usage) {
  return cost(BASELINE_MODEL, usage);
}

/** Every input token the request was billed for, cached or not. */
export function totalInputTokens(usage = {}) {
  return (
    (usage.inputTokens ?? 0) +
    (usage.cacheWrite5mTokens ?? 0) +
    (usage.cacheWrite1hTokens ?? 0) +
    (usage.cacheReadTokens ?? 0)
  );
}

/**
 * Human-readable label for a model id.
 */
export function modelLabel(modelId) {
  return rates(modelId)?.label ?? modelId;
}
