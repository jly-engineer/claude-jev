import { choice } from "@typesafe-ai/sdk";

// ── Tier table ──────────────────────────────────────────────────────────────
// Each tier is a (model, effort) pair. Cheapest first.
export const TIERS = [
  {
    name: "haiku",
    thinking: false,
    id: "claude-haiku-4-5-20251001",
    effort: null,
  },
  {
    name: "sonnet",
    thinking: true,
    id: "claude-sonnet-5",
    effort: "high",
  },
  {
    name: "opus",
    thinking: true,
    id: "claude-opus-4-6",
    effort: "high",
  },
];

export const TIER_NAMES = TIERS.map((t) => t.name);
export const rankOf = (name) => TIER_NAMES.indexOf(name);

/** Sentinel model id the proxy watches for. */
export const AUTO_MODEL = "jev-auto";
export const isAuto = (model) => model === AUTO_MODEL;

/** Resolve a tier name to its model spec, with env overrides. */
export function tierSpec(tierName) {
  const tier = TIERS.find((t) => t.name === tierName);
  if (!tier) return null;
  const stem = `CLAUDE_JEV_${tierName.toUpperCase()}`;
  return {
    ...tier,
    id: process.env[`${stem}_MODEL`] ?? tier.id,
    effort: process.env[`${stem}_EFFORT`] ?? tier.effort,
  };
}

/**
 * The model Claude Code sizes context and capabilities against for the
 * sentinel (`modelPicker.behavesAs`).
 *
 * Any turn can land on any tier, so this has to be the most conservative
 * tier — the cheapest one. Claiming a larger model here lets Claude Code
 * build a request the smallest tier cannot accept, which the API rejects
 * mid-session.
 *
 * Read lazily: the env file is loaded after module evaluation.
 */
export function behavesAsModel() {
  return process.env.CLAUDE_JEV_BEHAVES_AS ?? tierSpec(TIER_NAMES[0])?.id ?? TIERS[0].id;
}

// ── Jev question ────────────────────────────────────────────────────────────
export const QUESTIONS = {
  model_tier: choice(
    [
      "Pick the cheapest model tier that can fully complete this coding request in one pass.",
      "Judge the reasoning the request demands, not the length of the reply.",
      "Words like 'briefly' or 'short answer' describe the output format, not difficulty.",
    ],
    {
      haiku: {
        what: "Trivial, mechanical, or purely factual work.",
        signals: [
          "Rename a symbol, fix a typo, reformat, add a comment",
          "Answer a short factual question about a known file",
          "Run one obvious command and report the output",
        ],
        not_for:
          "Anything requiring design judgement or multi-file reasoning. " +
          "Styling, CSS properties, or JSX prop changes affecting state — these require design judgement.",
      },
      sonnet: {
        what: "Ordinary day-to-day engineering with a clear, bounded shape.",
        signals: [
          "Implement a well-specified function, endpoint, or component",
          "Write or fix tests for existing behaviour",
          "Localised bug fix where the cause is already understood",
          "Styling/CSS with multiple coordinated properties, or JSX state-affecting prop changes",
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
          "Performance issue where the root cause is unclear — 'slow even though X is small' is a diagnosis puzzle, not a known fix",
        ],
        not_for: "Work that a competent mid-level engineer would finish without thinking hard.",
      },
    },
  ),
};

// ── Policy thresholds ───────────────────────────────────────────────────────
export const THRESHOLDS = {
  minConfidence: 0.6,
  uncertainCeiling: "sonnet",
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};
