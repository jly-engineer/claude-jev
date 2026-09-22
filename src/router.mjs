import { TypeSafeClient } from "@typesafe-ai/sdk";
import { QUESTIONS, THRESHOLDS, TIER_NAMES, rankOf } from "./config.mjs";

let client;

function getClient() {
  client ??= new TypeSafeClient({
    apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY,
    baseURL: "https://api.typesafe.ai",
    timeout: THRESHOLDS.jevTimeoutMs,
    retry: { maxRetries: THRESHOLDS.jevMaxRetries, backoffInitialMs: 150, backoffMaxMs: 400 },
    logLevel: "warn",
  });
  return client;
}

/**
 * Asks Jev which tier fits this prompt.
 * Returns null on any failure — caller keeps the current model.
 */
export async function askJev(prompt) {
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  try {
    const result = await getClient().systemOne(
      { state: { request: prompt }, questions: QUESTIONS },
      { signal: abort.signal },
    );
    const answer = result.answers.model_tier;
    return { ...answer, ms: Date.now() - started };
  } catch (err) {
    if (process.env.JEV_DEBUG) {
      process.stderr.write(`[claude-jev] jev error: ${err.message}\n`);
    }
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Pure policy: turns a Jev answer into the tier to use.
 * Fail-open: any error or low confidence defaults to current tier.
 */
export function decide({ jev, current }) {
  if (!jev || !TIER_NAMES.includes(jev.choice)) {
    return { tier: current, reason: "jev-unavailable" };
  }

  let target = jev.choice;

  // Low confidence: never downgrade, cap upgrades at sonnet
  if (jev.confidence < THRESHOLDS.minConfidence) {
    if (rankOf(target) < rankOf(current)) {
      return { tier: current, reason: "low-confidence-no-downgrade" };
    }
    const ceiling = Math.max(rankOf(current), rankOf(THRESHOLDS.uncertainCeiling));
    if (rankOf(target) > ceiling) {
      return { tier: TIER_NAMES[ceiling], reason: "low-confidence-capped" };
    }
  }

  return { tier: target, reason: "jev" };
}
