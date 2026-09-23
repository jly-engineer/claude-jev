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
- **Cache tokens are most of the bill**: Claude Code caches nearly every turn, so `input_tokens` alone is a small fraction of billed input. `mergeUsage()` in `src/proxy.mjs` also captures `cache_creation_input_tokens` (preferring the per-TTL `cache_creation` breakdown) and `cache_read_input_tokens`; `cost()` prices them at 1.25x / 2x / 0.1x the model's input rate. Counts in the SSE stream are cumulative per response, so `mergeUsage` assigns rather than adds. Getting this wrong does not just shrink the numbers — cache reads bill at a tenth, so the actual and baseline sides move by different factors and the savings percentage itself goes wrong.
- **No silent $0**: An unpriced model id is costed at baseline rates and the event is flagged `estimated: true`. Returning 0 for an unknown model made any `CLAUDE_JEV_*_MODEL` override look free.
- **Conversation identity**: `conversationKey()` in `src/proxy.mjs` uses `metadata.user_id` when Claude Code sends one, else a SHA-1 of the system prompt plus the whole first message. It used to be the first 80 characters of message zero, which is identical boilerplate in every session — so all concurrent conversations shared one tier state. `touchConvo()` keeps the map to 50 entries by true LRU (re-insert on touch), so a long-running session is not evicted by fresh ones.
- **Ledger writers**: `readEvents()` is a pure read. Compaction is `prune()`, called once from `bin/claude-jev.mjs` before the proxy starts appending, via temp file + rename. Pruning inside the read path meant the dashboard's 5-second poll rewrote the file under live appends. Still not safe to prune while another session is appending — startup is the one moment the process knows it has no writes in flight.
- **Dashboard chat has two backends**: `agent` (default) spawns headless `claude -p` with `ANTHROPIC_BASE_URL` at the proxy and `ANTHROPIC_MODEL=jev-auto`, so it routes off the normal sentinel path — a real Claude Code request carries tools and survives `extractPrompt()`. The child authenticates itself, which is why a Pro/Max subscription works and we never touch the credential. `api` (`src/chat.mjs`) is the fallback for an API key; it must call `askJev()`/`decide()` itself, because a toolless request would never be routed by the proxy, and it never requests `thinking` so tier changes cannot orphan a signature. Both require the proxy: without it the turn is neither routed nor recorded, which is not claude-jev.
- **The agent's safety boundary is `--disallowed-tools`, not `--allowed-tools`**: an allowlist grants, it does not confine. With `--permission-mode acceptEdits` and `--allowed-tools Read Glob Grep`, the agent still called `Write` and created a file — verified. `--disallowed-tools` refuses outright ("disabled for this session, in subagents as well as here"), so `CLAUDE_JEV_AGENT_DENY` carries the default `Write Edit NotebookEdit Bash PowerShell KillShell Task`. `Task` is on it because a subagent would otherwise be a way around. Setting it empty is an explicit opt-in to a writable agent driven from a web page. A blocked tool surfaces as a `denied` event so the chat can explain it instead of stalling on a permission the browser cannot grant.
- **Slash commands are discovered twice**: `src/skills.mjs` scans `~/.claude/{skills,commands}`, the project's `.claude/`, and `~/.claude/plugins/cache/*/<plugin>/*/skills` so the typeahead works before any turn and so descriptions exist at all. `adoptSlashCommands()` then replaces that list with `slash_commands` from Claude Code's `init` stream event, which is authoritative — it knows plugin namespacing, precedence and built-ins. Captured off turns that happen anyway, so it costs nothing. Frontmatter parsing must handle YAML folded (`>`) and literal (`|`) block scalars or a description reads as a bare `>`.
- **Usage caps come from the stream, not headers**: headless Claude Code emits `rate_limit_event` with `rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}`. `captureFromRateLimitEvent()` ingests it. This is more reliable than the `anthropic-ratelimit-unified-*` response headers, which only appear on subscription logins and not on every response. The gauge is in-memory, so it is empty until the first response of a session — the dashboard now says that rather than hiding the section.
- **The dashboard is same-origin only**: no CORS header, a loopback `Host` allowlist against DNS rebinding, and a per-process token substituted into the page at serve time. This got strict when `/api/chat` arrived — a wildcard CORS header on an endpoint that spends money is a different problem from one that leaks numbers.
- **"Today" is calendar-local**: `aggregate()` cuts at local midnight. The 7- and 30-day buckets stay rolling windows, matching their labels.
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
| `src/web-server.mjs` | HTTP server: `/`, `/chat`, `/api/savings`, `/api/chat` SSE, Host+token guard |
| `src/chat.mjs` | Direct-API chat backend: per-session history, tier selection, request shaping |
| `src/agent.mjs` | Headless Claude Code chat backend: spawn, stream-json parsing, tool allowlist |
| `src/env.mjs` | `~/.claude-jev.env` loader, shared by the launcher and the routing tests |
| `src/web-dashboard.html` | Dashboard: metrics, usage gauges, recent requests. Links to `/chat` |
| `src/web-chat.html` | Full-screen chat page at `/chat`, with the `/` command typeahead |
| `src/skills.mjs` | Slash-command discovery: filesystem scan + Claude Code's authoritative list |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `JEV_API_KEY` / `TYPESAFE_API_KEY` | Jev API key. Read from env or `~/.claude-jev.env` |
| `JEV_DEBUG=1` | Logs to `~/.claude-jev/debug.log` |
| `CLAUDE_JEV_<TIER>_MODEL` | Override a tier's model ID |
| `CLAUDE_JEV_<TIER>_EFFORT` | Override a tier's effort level |
| `CLAUDE_JEV_LEDGER_PATH` | Override ledger file location |
| `CLAUDE_JEV_BEHAVES_AS` | Override the model the sentinel reports as (default: cheapest tier) |
| `ANTHROPIC_API_KEY` | Fallback chat backend. Not needed on a Pro/Max subscription |
| `CLAUDE_JEV_CHAT` | `agent` (default) / `api` / `off` |
| `CLAUDE_JEV_AGENT_TOOLS` | Agent chat tool allowlist (grants). Default `Read Glob Grep` |
| `CLAUDE_JEV_AGENT_DENY` | Agent chat tool denylist (the real boundary). Empty = writable |
| `CLAUDE_JEV_AGENT_CWD` | Working directory for agent chat |

## Known issues / things to watch

- **Token capture requires plaintext SSE** — `accept-encoding` is stripped from upstream requests. If Anthropic ever requires it, this will need a decompression step.
- **Usage gauges require subscription login** — The `anthropic-ratelimit-unified-*` headers only appear for Pro/Max subscription logins, not API key auth.
- **Windows `.exe` preference** — `where claude` returns extensionless shell scripts first on Windows; `findClaude()` prefers `.exe` then `.cmd`.
- **Dashboard dies with session** — The web dashboard runs in the same process as the proxy. When `claude-jev` exits, the dashboard goes down.

## Testing

```bash
npm test                  # unit suite: free, offline, no keys, ~200ms
npm run test:routing      # routing accuracy: COSTS MONEY, one Jev call per case
```

`test/README.md` covers both, including how to read the accuracy number
honestly. Short version:

- `test/unit/*.test.mjs` is `node:test`, no network. Tests tagged `regression:`
  encode a bug that shipped once — do not delete one casually.
- `test/routing/cases.mjs` is the single source of truth for the 25 routing
  cases and their hand-labelled tiers. Changing an `expected` changes the spec.
- `test/routing/run.mjs` takes `--only T08,T09` and `--json`. It exits 2
  without a Jev key, and non-zero below 85% accuracy.
- `test/routing/judge.mjs` is an advisory second opinion from a frontier model.
  Its rubric is deliberately a separate copy, not an import of `QUESTIONS` —
  grading the router against its own guidance would be circular.

Run the routing suite when you touch the tier guidance in `src/config.mjs` or
the policy in `decide()`, not on every commit.

```bash
# Debug a live session
JEV_DEBUG=1 claude-jev
cat ~/.claude-jev/debug.log
```
