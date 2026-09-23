# Tests

Two suites, split by whether running them costs money.

## `npm test` — unit, free, offline

```bash
npm test
```

45 assertions, no network, no API keys, ~200ms. Safe in CI and in a pre-commit
hook. Covers the parts where a silent regression is expensive:

| File | What it pins |
|------|--------------|
| `unit/pricing.test.mjs` | Per-model rates, cache multipliers, dated-id normalization, and that an unpriced model is never costed at $0 |
| `unit/usage.test.mjs` | `mergeUsage()` — cache token capture, and that cumulative stream counts are assigned rather than summed |
| `unit/thinking.test.mjs` | `stripThinkingHistory()` — removal, empty-turn drop, and that a `tool_use` is never separated from its `tool_result` |
| `unit/conversation.test.mjs` | `conversationKey()` collision resistance and `touchConvo()` LRU eviction |
| `unit/ledger.test.mjs` | Reads never write, `prune()` is atomic and idempotent, "Today" cuts at local midnight |
| `unit/router.test.mjs` | `decide()` fail-open contract, and that uncertainty resolves *downward* |

Several are explicitly labelled `regression:` — they encode a bug that shipped
once. Deleting one should be a deliberate decision, not a cleanup.

## `npm run test:routing` — routing accuracy, paid

```bash
npm run test:routing                              # all 25 cases
node test/routing/run.mjs --only T08,T09,T15      # a subset
node test/routing/run.mjs --json                  # machine-readable
```

One live Jev call per case. Needs `JEV_API_KEY` (or `TYPESAFE_API_KEY`) and
exits 2 without one. Run it when you change the tier guidance in
`src/config.mjs` or the policy in `decide()` — not on every commit.

Exits non-zero below 85% accuracy.

`test/routing/cases.mjs` is the single source of truth: 25 prompts (7 trivial,
9 typical, 9 complex) with a hand-labelled expected tier. `expected` is a human
judgement, not a model's. Changing one changes the spec for the router.

### Reading the result honestly

The score measures whether Jev, reading the guidance in `config.mjs`, agrees
with the hand labels. It does not measure whether those labels are right, and
it does not measure generalization. Cases the guidance was *written from* will
pass close to by construction — a jump right after editing the guidance
confirms the edit landed, nothing more. The set is worth expanding with
held-out cases: mixed-complexity prompts, ambiguous scope.

At N=25 a single flipped case moves the score four points. Treat small
movements as noise.

A miss at **confidence ≥ 0.80** is the informative one: Jev was sure and
wrong, so no confidence threshold at any value could have caught it. That is a
tier-guidance problem, not a policy problem. `run.mjs` calls these out
separately for that reason.

### `judge.mjs` — advisory only

```bash
node test/routing/judge.mjs T08 "the prompt text"
```

Asks a frontier model for a second opinion on one prompt. Needs
`ANTHROPIC_API_KEY`. Not wired into `test:routing`, and its rubric is a
deliberately separate copy rather than an import of `QUESTIONS` — feeding the
judge the router's own guidance would make the comparison circular. Use it to
interrogate a specific disagreement, not to generate scores.
