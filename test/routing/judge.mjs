#!/usr/bin/env node
/**
 * Advisory second opinion: ask a frontier model which tier a prompt needs.
 *
 * THIS COSTS MONEY and needs ANTHROPIC_API_KEY. It is not wired into
 * `npm run test:routing`, which grades against the hand labels in cases.mjs.
 *
 *   node test/routing/judge.mjs T08 "the prompt text"
 *
 * The rubric below is deliberately a SEPARATE copy, not an import of
 * QUESTIONS from src/config.mjs. Feeding the judge the same guidance the
 * router reads would make the comparison circular — both sides would be
 * answering "does this match the guidance?" rather than "what does this
 * prompt actually need". Keep it independent, and expect it to drift.
 */

import { Anthropic } from "@anthropic-ai/sdk";

// ── Tier guidance from config ───────────────────────────────────────────────
const TIER_GUIDANCE = {
  haiku: {
    what: "Trivial, mechanical, or purely factual work.",
    signals: [
      "Rename a symbol, fix a typo, reformat, add a comment",
      "Answer a short factual question about a known file",
      "Run one obvious command and report the output",
    ],
    not_for: "Anything requiring design judgement or multi-file reasoning.",
  },
  sonnet: {
    what: "Ordinary day-to-day engineering with a clear, bounded shape.",
    signals: [
      "Implement a well-specified function, endpoint, or component",
      "Write or fix tests for existing behaviour",
      "Localised bug fix where the cause is already understood",
    ],
    not_for: "Open-ended architecture, subtle concurrency, or deep unknown-cause debugging.",
  },
  opus: {
    what: "Hard reasoning, ambiguity, or high blast radius.",
    signals: [
      "Debug a failure whose cause is unknown",
      "Design or refactor across several modules",
      "Security, auth, concurrency, data-migration, or money-handling logic",
      "Weigh a trade-off and commit to one answer",
    ],
    not_for: "Work that a competent mid-level engineer would finish without thinking hard.",
  },
};

async function judgePrompt(testId, prompt) {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const guidanceText = Object.entries(TIER_GUIDANCE)
    .map(
      ([tier, def]) =>
        `## ${tier.toUpperCase()}\n${def.what}\n\nSignals:\n${def.signals.map((s) => `- ${s}`).join("\n")}\n\nNot for: ${def.not_for}`
    )
    .join("\n\n");

  const systemPrompt = `You are a tier-selection oracle for a model routing system.

${guidanceText}

Your task: Given a coding request, judge which tier can handle it in one turn:
1. haiku: purely mechanical, trivial, or factual
2. sonnet: bounded engineering work with clear shape
3. opus: hard reasoning, unknown-cause debugging, architecture, or high blast radius

Respond as JSON: { "tier": "haiku"|"sonnet"|"opus", "confidence": 0.0-1.0, "reason": "..." }

Base confidence on:
- 0.95+: Clear case with no ambiguity
- 0.80-0.95: Likely correct, minor uncertainties
- 0.60-0.80: Plausible but some ambiguity
- <0.60: High uncertainty or borderline

Do NOT add markdown formatting, just raw JSON.`;

  const userPrompt = `Classify this request:\n\n${prompt}`;

  const message = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 200,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";

  // Parse JSON response
  try {
    const result = JSON.parse(text);
    if (!["haiku", "sonnet", "opus"].includes(result.tier)) {
      throw new Error(`Invalid tier: ${result.tier}`);
    }
    if (typeof result.confidence !== "number" || result.confidence < 0 || result.confidence > 1) {
      throw new Error(`Invalid confidence: ${result.confidence}`);
    }
    return result;
  } catch (err) {
    console.error(`[WARN] Oracle judge ${testId} failed to parse: ${err.message}\nRaw: ${text}`);
    // Fallback
    return {
      tier: "sonnet",
      confidence: 0.5,
      reason: `parse-error: ${err.message}`,
    };
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────
const testId = process.argv[2];
const prompt = process.argv[3];

if (!testId || !prompt) {
  console.error("Usage: oracle-judge.mjs <testId> <prompt>");
  process.exit(1);
}

judgePrompt(testId, prompt)
  .then((result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[FATAL] ${err.message}`);
    process.exit(1);
  });
