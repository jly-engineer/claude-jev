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
- **The proxy prints nothing**: routing goes to `~/.claude-jev/current.json` (`src/state.mjs`, temp+rename so a reader never sees half a file) and is rendered by `bin/statusline.mjs` in Claude Code's status line — the one row it owns. The old stderr banner wrote cursor-control sequences into a terminal Claude Code was repainting, and `await animateSwitch(...)` delayed every request ~600ms. `writeState()` is fire-and-forget and swallows everything: a cosmetic file must never be able to fail a request.
- **A statusLine is only injected when the user has none**: our `--settings` file outranks `settings.json`, so setting one unconditionally would silently replace theirs for the session. `CLAUDE_JEV_STATUSLINE=1` forces it, `0` disables it.
- **Debug logging is counts, not text**: `JEV_DEBUG=1` logs tiers, timings and token counts; prompt text needs `JEV_DEBUG_PROMPTS=1`. The log rotates at 5MB keeping one generation, because it previously grew forever while recording 80 characters of every prompt.
- **Report new tokens, not raw input**: `aggregate()` splits input into `newInputTokens` (uncached + cache writes) and `cacheReadTokens`, and both dashboards lead with the former. An agent turn is several requests and each one's cache read is roughly the previous request's whole input, so summing `inputTokens` counts the same prefix repeatedly — a real ledger read 5.7M against 764k of genuine new content for the same $1.84. Events written before cache accounting have no breakdown; their `inputTokens` were uncached-only, so they count wholly as new.
- **Cache tokens are most of the bill**: Claude Code caches nearly every turn, so `input_tokens` alone is a small fraction of billed input. `mergeUsage()` in `src/proxy.mjs` also captures `cache_creation_input_tokens` (preferring the per-TTL `cache_creation` breakdown) and `cache_read_input_tokens`; `cost()` prices them at 1.25x / 2x / 0.1x the model's input rate. Counts in the SSE stream are cumulative per response, so `mergeUsage` assigns rather than adds. Getting this wrong does not just shrink the numbers — cache reads bill at a tenth, so the actual and baseline sides move by different factors and the savings percentage itself goes wrong.
- **No silent $0**: An unpriced model id is costed at baseline rates and the event is flagged `estimated: true`. Returning 0 for an unknown model made any `CLAUDE_JEV_*_MODEL` override look free.
- **Conversation identity**: `conversationKey()` in `src/proxy.mjs` uses `metadata.user_id` when Claude Code sends one, else a SHA-1 of the system prompt plus the whole first message. It used to be the first 80 characters of message zero, which is identical boilerplate in every session — so all concurrent conversations shared one tier state. `touchConvo()` keeps the map to 50 entries by true LRU (re-insert on touch), so a long-running session is not evicted by fresh ones.
- **Ledger writers**: `readEvents()` is a pure read. Compaction is `prune()`, called once from `bin/claude-jev.mjs` before the proxy starts appending, via temp file + rename. Pruning inside the read path meant the dashboard's 5-second poll rewrote the file under live appends. Still not safe to prune while another session is appending — startup is the one moment the process knows it has no writes in flight.
- **Dashboard chat has two backends**: `agent` (default) spawns headless `claude -p` with `ANTHROPIC_BASE_URL` at the proxy and `ANTHROPIC_MODEL=jev-auto`, so it routes off the normal sentinel path — a real Claude Code request carries tools and survives `extractPrompt()`. The child authenticates itself, which is why a Pro/Max subscription works and we never touch the credential. `api` (`src/chat.mjs`) is the fallback for an API key; it must call `askJev()`/`decide()` itself, because a toolless request would never be routed by the proxy, and it never requests `thinking` so tier changes cannot orphan a signature. Both require the proxy: without it the turn is neither routed nor recorded, which is not claude-jev.
- **Pasted images reach the agent as files, not bytes**: `claude -p` takes a text prompt, so `src/uploads.mjs` writes the paste to `~/.claude-jev/uploads` and the path goes into the prompt as `[image: <path>]`. That directory is unconditionally first in the agent's `--add-dir`, or every paste would fail as an out-of-scope read. The direct-API backend has no filesystem on the far end, so it reads the file back and sends base64 image content blocks instead. Type is decided by magic bytes — a declared Content-Type is attacker-controlled, and this directory is one the agent can read. Filenames are generated and the extension derived, so nothing from the request reaches the path. `/api/chat` only honours image paths under the uploads directory.
- **Chats are saved server-side, not in the browser**: `src/chats.mjs` writes one JSON file per chat to `~/.claude-jev/chats/` (temp + rename), so a chat survives a refresh, the dashboard round trip, a restart, and shows up on any device. The browser keeps only the open chat's id in `localStorage`. Each file holds the display transcript (text, images, tier, model, denials, errors) plus internal state the page never sees: the agent's Claude Code `agentSession`, or the direct-API `api.messages` history. The user message is saved before the turn runs and the reply after it ends — even if the browser disconnected — so reopening shows what happened. After a restart the in-memory session is empty, so `agentChat()` restores `agentSession` from the file and `--resume`s the same Claude Code conversation instead of starting over. Delete removes the file **and** `~/.claude/projects/*/<session>.jsonl` (plus its subagent directory), so a deleted chat is gone from Claude Code's history too. Chat ids come from the browser and become filenames: `validChatId()` (`chat-[a-z0-9]{6,32}`) guards every route, and only a UUID is ever used to find a transcript. Reading an id with no file returns an empty chat, not a 404 — the page opens a fresh id on every first visit. Pasted images are pruned after 24h, so older chats show "image no longer available".
- **Three different ways the agent gets blocked**: a tool on the denylist is refused outright ("No such tool available"), while an *allowed* tool used outside the working directory stalls instead ("requested permissions to write to ..., but you haven't granted it yet") — `acceptEdits` only auto-approves edits under the cwd, and headless has no approval channel. `CLAUDE_JEV_AGENT_DIRS` (semicolon-separated, because Windows paths contain spaces) adds roots via `--add-dir`. A third case is a tool that is simply not in `--allowed-tools`, which reports as "requested permissions to use <Tool>" — no path, different wording, different remedy (`CLAUDE_JEV_AGENT_TOOLS`). All three are classified by `detectDenial()` in `src/agent.mjs`, which is exported and tested because each phrasing was missed in turn; a `permission_denials` array on the result event is a structured backstop. They become a `denied` event carrying `reason: "disabled" | "path" | "ungranted"`, so the chat can name the right remedy instead of the agent claiming it awaits a permission nobody can give.
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
| opus   | claude-opus-5                | high   | yes      |

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
| `src/state.mjs` | Current routing decision on disk, for the status line |
| `bin/statusline.mjs` | Renders the tier and today's saving in Claude Code's status line |
| `src/skills.mjs` | Slash-command discovery: filesystem scan + Claude Code's authoritative list |
| `src/chats.mjs` | Saved chats: per-chat JSON files, list, delete (with the Claude Code transcript) |

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
| `CLAUDE_JEV_AGENT_DIRS` | Extra writable roots, `;`-separated, passed as `--add-dir` |
| `CLAUDE_JEV_UPLOAD_DIR` | Where pasted chat images are stored |
| `CLAUDE_JEV_CHAT_DIR` | Where saved chats are stored. Default `~/.claude-jev/chats` |
| `CLAUDE_JEV_STATE_PATH` | Status-line state file |
| `CLAUDE_JEV_STATUSLINE` | `1` force our status line, `0` never |
| `JEV_DEBUG_PROMPTS` | `1` also logs prompt text |

## Known issues / things to watch

- **Token capture requires plaintext SSE** — `accept-encoding` is stripped from upstream requests. If Anthropic ever requires it, this will need a decompression step.
- **Usage gauges need a subscription login and one response** — utilization now comes from Claude Code's `rate_limit_event` stream event, with the `anthropic-ratelimit-unified-*` response headers as a secondary source. Both are subscription-only; API-key auth reports no unified caps. State is in memory, so the gauges are empty until the first response of a session.
- **Windows `.exe` preference** — `where claude` returns extensionless shell scripts first on Windows; `findClaude()` prefers `.exe` then `.cmd`.
- **Dashboard dies with session** — The web dashboard runs in the same process as the proxy. When `claude-jev` exits, the dashboard goes down.
- **A settings `env` block can bypass the proxy (fixed in `7be63bc`)** — Claude Code applies `env` from `settings.json` / `settings.local.json` over the process environment, so a user who routes through another local proxy (e.g. Headroom on `:8787`) sent `jev-auto` straight upstream and got a 404 "issue with the selected model". The launcher now writes `ANTHROPIC_BASE_URL` into its generated `--settings` file, which outranks user and local settings. Symptom if it regresses: that 404, and `debug.log` showing no requests at all. A side effect: inside `claude-jev`, the other proxy is skipped — our upstream is hard-coded to `api.anthropic.com`.
- **Inline comments in `~/.claude-jev.env` (fixed in `55aaddc`)** — `KEY="value"   # note` used to keep everything after the `=` minus one trailing quote, so `CLAUDE_JEV_AGENT_CWD` became a nonexistent path. Node reports a bad `cwd` as `spawn /path/to/claude ENOENT`, naming the binary rather than the directory — check the chat's `backend` event for the resolved `cwd` before suspecting the binary. `#` is only a comment outside quotes.
- **Executable bit on `bin/claude-jev.mjs` (fixed in `6c6ba40`)** — the file was committed as `100644`, and `npm link` sets `+x`, leaving a mode-only change that blocked `git pull` on Linux and macOS. It is now `100755` in git. Do not recommend `core.fileMode false` as a workaround: a later pull can then drop the bit silently and `claude-jev` fails with `Permission denied`.

## Deploying a change

`npm link` symlinks the global `claude-jev` at this checkout, so `git pull` is
the upgrade. Everything else needs a **restart** — nothing reloads in place:
`src/*.mjs` is cached by Node for the process lifetime, `~/.claude-jev.env` is
read once at launch, the sentinel settings file is written at launch, and the
chat backend is decided when the dashboard server starts. A running session
keeps old behaviour entirely, old pricing included.

Gate a deploy on `npm test` (offline, no keys). Run `npm run test:routing`
only when the tier guidance in `src/config.mjs` or `decide()` changed — it costs
one Jev call per case.

Config lives in `~/.claude-jev.env`. Two things bite repeatedly:

- **Multiple agent directories** are one `CLAUDE_JEV_AGENT_DIRS` line separated
  by semicolons. A repeated key does not merge — the last line wins. Semicolons
  rather than commas or spaces because Windows paths carry spaces and a drive
  colon.
- **Encoding.** Windows PowerShell writes UTF-16 LE, PowerShell 7 writes UTF-8.
  The parser handles either, but a file containing both is corrupt, and the API
  key goes with it. Append with `Add-Content -Encoding Unicode` against a UTF-16
  file, or convert the file to UTF-8 once.

After restarting, the composer hint under the chat box is the fastest check that
config took effect: it prints the agent's posture, tool list and every writable
directory. If it disagrees with the env file, the restart did not happen.

After a pricing change, consider `claude-jev savings --reset`. Events are costed
at record time, so old rows keep the old rates and the dashboard blends them
with current ones.

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
