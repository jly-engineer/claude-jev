# CLAUDE.md — Project Notes for claude-jev

## What this is

A Claude Code wrapper that uses TypeSafe Jev (System One model) to auto-route each prompt to the cheapest Claude model that can handle it. Saves money by sending trivial work to Haiku instead of Opus.

## Architecture

```
claude-jev (bin/claude-jev.mjs)
  ├── starts local HTTP proxy (src/proxy.mjs) on random loopback port
  ├── starts web dashboard (src/web-server.mjs) on port 3579
  ├── launches real `claude` CLI with ANTHROPIC_BASE_URL → proxy
  └── registers "jev-auto" sentinel via --settings modelPicker

Proxy flow per request:
  1. Claude Code sends request with model "jev-auto"
  2. Proxy extracts user's latest turn text
  3. Jev classifies prompt → haiku/sonnet/opus tier (~200ms)
  4. Proxy rewrites model field + effort, forwards to api.anthropic.com
  5. Captures token usage from SSE stream + rate-limit headers from response
  6. Records to JSONL ledger for dashboard
```

## Key design decisions

- **Fail-open**: Every Jev error/timeout keeps the current model. Never blocks a prompt.
- **Sentinel model**: `jev-auto` is a fake model ID that Claude Code sends verbatim (it doesn't validate model names behind a custom base URL). The proxy recognizes it as "route this".
- **behavesAs**: The sentinel is registered via `--settings` with `behavesAs` set to the **cheapest** tier's model (`behavesAsModel()` in `src/config.mjs`), so Claude Code knows the context window and capabilities. It must be the cheapest tier, not the middle one — any turn can route down to it, and a request sized for a larger model gets rejected upstream mid-session. Override with `CLAUDE_JEV_BEHAVES_AS` when every tier shares a context window.
- **Thinking blocks are model-scoped**: A thinking block's signature only verifies on the model that produced it. `stripThinkingHistory()` in `src/proxy.mjs` removes `thinking` / `redacted_thinking` blocks from the history whenever the tier changes, or when the target tier cannot think. It only runs on a fresh user turn — tool-loop continuations keep their pinned tier, so a pending `tool_use` is never separated from its thinking block.
- **Permissions**: The launcher always appends `--dangerously-skip-permissions`. Intentional — the wrapper is for unattended routing runs.
- **No accept-encoding**: The proxy strips `accept-encoding` from upstream requests so responses come back as plaintext SSE, which the token capture parser can read.
- **Dashboard port**: Tries 3579, falls back to random if taken (multiple sessions).
- **Dashboard URL file**: Written to `~/.claude-jev/dashboard.url` since the startup banner scrolls away when Claude Code takes over the terminal.
- **UTF-16 env files**: PowerShell's `Set-Content` writes UTF-16 BOM by default. The env file parser handles this.

## Current tier table

| Tier   | Model                        | Effort | Thinking |
|--------|------------------------------|--------|----------|
| haiku  | claude-haiku-4-5-20251001    | null   | no       |
| sonnet | claude-sonnet-5              | high   | yes      |
| opus   | claude-opus-4-6              | high   | yes      |

Default starting tier is **haiku**. Jev upgrades when needed.

## File layout

| File | Role |
|------|------|
| `bin/claude-jev.mjs` | CLI entry: env loading, subcommands (`savings`, `dashboard`), proxy+dashboard startup, claude spawn |
| `src/config.mjs` | Tier definitions, Jev `choice()` question, thresholds, override patterns |
| `src/router.mjs` | Jev SDK client, `askJev()`, `decide()` policy function |
| `src/proxy.mjs` | HTTP proxy: request interception, model rewrite, SSE token capture, rate-limit header capture |
| `src/pricing.mjs` | Per-model USD/MTok pricing, baseline cost comparison |
| `src/ledger.mjs` | Append-only JSONL ledger at `~/.claude-jev/usage.jsonl`, read/aggregate/reset |
| `src/dashboard.mjs` | Terminal savings renderer (headroom-style bars) |
| `src/usage-state.mjs` | In-memory state for `anthropic-ratelimit-unified-*` headers |
| `src/web-server.mjs` | Dashboard HTTP server, serves HTML + `/api/savings` JSON |
| `src/web-dashboard.html` | Single-page web dashboard with live charts, usage gauges, recent requests |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `JEV_API_KEY` / `TYPESAFE_API_KEY` | Jev API key. Read from env or `~/.claude-jev.env` |
| `JEV_DEBUG=1` | Logs to `~/.claude-jev/debug.log` |
| `CLAUDE_JEV_<TIER>_MODEL` | Override a tier's model ID |
| `CLAUDE_JEV_<TIER>_EFFORT` | Override a tier's effort level |
| `CLAUDE_JEV_LEDGER_PATH` | Override ledger file location |
| `CLAUDE_JEV_BEHAVES_AS` | Override the model the sentinel reports as (default: cheapest tier) |

## Known issues / things to watch

- **Token capture requires plaintext SSE** — `accept-encoding` is stripped from upstream requests. If Anthropic ever requires it, this will need a decompression step.
- **Usage gauges require subscription login** — The `anthropic-ratelimit-unified-*` headers only appear for Pro/Max subscription logins, not API key auth.
- **Windows `.exe` preference** — `where claude` returns extensionless shell scripts first on Windows; `findClaude()` prefers `.exe` then `.cmd`.
- **Dashboard dies with session** — The web dashboard runs in the same process as the proxy. When `claude-jev` exits, the dashboard goes down.

## Testing

```bash
# Verify modules parse
node -e "import './src/proxy.mjs'"

# Test routing policy
node -e "
import { decide } from './src/router.mjs';
console.log(decide({ jev: { choice: 'haiku', confidence: 0.95 }, current: 'sonnet' }));
console.log(decide({ jev: null, current: 'sonnet' }));
"

# Test dashboard with seeded data
node -e "
import { record, reset } from './src/ledger.mjs';
import { cost, baselineCost } from './src/pricing.mjs';
reset();
record({ model: 'claude-haiku-4-5-20251001', tier: 'haiku', inputTokens: 5000, outputTokens: 2000,
  cost: cost('claude-haiku-4-5-20251001', 5000, 2000), baselineCost: baselineCost(5000, 2000) });
import { renderDashboard } from './src/dashboard.mjs';
console.log(renderDashboard());
"

# Debug a live session
JEV_DEBUG=1 claude-jev
cat ~/.claude-jev/debug.log
```
