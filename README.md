# claude-jev

A wrapper for [Claude Code](https://code.claude.com) that uses [TypeSafe Jev](https://docs.typesafe.ai) to automatically route each prompt to the cheapest model that can handle it.

A typo fix goes to Haiku. A standard implementation goes to Sonnet. A hard debugging session goes to Opus. You don't pick — Jev decides in ~200ms for a fraction of a cent, and the proxy rewrites the model field before it reaches the API.

```
you -> claude (real CLI, real UI) -> claude-jev proxy -> api.anthropic.com
                                          |
                                          +-> Jev: which tier fits this prompt?
```

Everything about Claude Code is unchanged — tools, keybindings, `/compact`, `/resume`, session handling. Only the model is rewritten.

> **Note:** `claude-jev` always launches Claude Code with `--dangerously-skip-permissions`. Tool calls run without prompting for approval. Use it only in directories and on machines where that is acceptable.

## Quick start

```bash
git clone https://github.com/jly-engineer/claude-jev.git
cd claude-jev
npm install
npm link

# Set your Jev key (free from https://console.typesafe.ai/keys)
echo "JEV_API_KEY=sk-..." > ~/.claude-jev.env

# Launch
claude-jev
```

## How it works

`claude-jev` starts a local HTTP proxy on a random loopback port and launches Claude Code with `ANTHROPIC_BASE_URL` pointing at it. Every user turn is sent to Jev for classification (~70-500ms, $0.042/MTok input, output free). The proxy rewrites the `model` field and forwards the request upstream.

### Routing tiers

| Tier | Model | When |
|------|-------|------|
| **haiku** | `claude-haiku-4-5-20251001` | Typo fixes, renames, factual lookups, mechanical edits |
| **sonnet** | `claude-sonnet-5` | Standard implementations, test writing, known bug fixes |
| **opus** | `claude-opus-5` | Unknown-cause debugging, multi-module design, security logic |

### Fail-open design

Every error path keeps the current model:

- Jev unreachable or times out -> keep current tier
- Low confidence (<0.6) -> never downgrade, cap upgrades at sonnet
- Non-routed requests (user picked a model, tool continuations) -> pass through untouched

### Status line

The routing decision appears in Claude Code's own status line:

```
⚡ haiku→sonnet p=0.92  ·  $5.77 saved today · 76%
```

The proxy writes nothing to the terminal. It used to print an animated switch
banner on stderr, cursor-control sequences and all, into the same terminal
Claude Code repaints — which scrambled the display — and it blocked each
request for ~600ms before forwarding. Both are gone. The decision is written to
`~/.claude-jev/current.json` and rendered by `bin/statusline.mjs`, which reads
that file plus today's ledger.

**If you already have a status line, yours is kept.** `claude-jev` passes its
own `--settings` file, which outranks `settings.json`, so injecting a
`statusLine` unconditionally would silently replace yours for the session. It
is added only when no status line is configured. Override either way:

```env
CLAUDE_JEV_STATUSLINE=1   # always use ours, replacing an existing one
CLAUDE_JEV_STATUSLINE=0   # never
```


## Savings dashboard

Track what you're saving compared to running everything on Opus 5.

### Terminal

```bash
claude-jev savings              # headroom-style terminal dashboard
claude-jev savings --json       # machine-readable output
claude-jev savings --days 7     # restrict lookback window (1-30)
claude-jev savings --reset      # clear the ledger
```

```
  ⚡ claude-jev savings  vs always using Opus 5
  ─────────────────────────────────────────────────────────────────

  Today          ██████████████░░░░░░ 69.2% saved  66.0k tokens  $1.51 saved  (5 reqs)
  Last 7 days    ██████████████░░░░░░ 69.2% saved  66.0k tokens  $1.51 saved  (5 reqs)
  Last 30 days   ██████████████░░░░░░ 69.2% saved  66.0k tokens  $1.51 saved  (5 reqs)

  Cost breakdown by tier:

  haiku       3 reqs    39.0k tokens     $1.18 saved  (actual: $0.07)
  sonnet      1 reqs    12.0k tokens     $0.34 saved  (actual: $0.08)
  opus        1 reqs    15.0k tokens     $0.00 saved  (actual: $0.53)
```

### Reading the token numbers

The dashboards lead with **new** tokens — fresh input plus cache writes — and
show **cached** separately. That distinction matters more than it sounds.

The API is stateless, so every request re-sends the whole conversation. Prompt
caching means the repeated prefix is served from cache at a tenth of the input
rate rather than reprocessed. On top of that, one chat turn runs an agent loop
of several requests, and each request's cache read is roughly the previous
request's entire input.

Summing raw input therefore counts the same conversation over and over: a real
ledger here showed 5.7M "tokens" against 764k of actual new content, for the
same $1.84. The raw figure tracks conversation length, not work done, and reads
as alarming for no reason. Costs were always right; only the token column
misled.

### Web dashboard

A live web dashboard runs automatically alongside every `claude-jev` session at **http://127.0.0.1:3579**. Or launch it standalone:

```bash
claude-jev dashboard    # opens browser to http://127.0.0.1:3579
```

Features:
- **Chat** — a full-screen Claude Code agent at `/chat`, routed by Jev, works on a Pro subscription
- **Summary cards** — You Saved / Actual Spend / Opus 5 Would Be
- **Claude usage gauges** — 5-hour session cap and weekly cap with reset countdowns
- **Savings over time** — progress bars for today / 7 days / 30 days
- **Routing breakdown** — per-tier request counts, tokens, costs, and savings
- **Recent requests** — last 15 requests with tier badges and per-request savings
- **Auto-refreshes every 5 seconds**

### Chat

Chat lives on its own full-screen page at **http://127.0.0.1:3579/chat** (linked from the dashboard header). It drives **headless Claude Code**: each turn
spawns `claude -p` with `ANTHROPIC_BASE_URL` pointed at the proxy and the
`jev-auto` sentinel as the model. So the turn is routed by Jev, lands in the
ledger, and moves the savings figures on the same page.

Because the thing making the request genuinely is Claude Code, **a Claude
Pro/Max subscription works — no API key needed.** The child authenticates
itself; `claude-jev` never sees or stores the credential. Usage counts against
the same 5-hour and weekly caps the gauges show.

**Paste an image** into the composer, or drop one on it. Screenshots go
straight in. The file is written to `~/.claude-jev/uploads`, which the agent is
always granted read access to, and the path is put in the prompt so it can read
it; the direct-API backend sends the bytes as content blocks instead. Uploads
older than a day are pruned, PNG/JPEG/GIF/WebP only, 10MB each, and the format
is decided by sniffing the file's own bytes rather than by what the browser
claimed.

Type `/` in the composer to autocomplete your skills and slash commands —
user skills, project skills, plugin skills (namespaced, e.g. `caveman:caveman-help`)
and `.claude/commands` files. Arrow keys to move, Tab or Enter to complete,
Escape to dismiss. They run for real: `/caveman-help` invokes the skill.

The list is scanned from disk so it works immediately, then replaced by Claude
Code's own `slash_commands` list after the first turn, which also picks up
built-ins. Note the agent's tool allowlist still applies — a skill that needs
`Bash` or `Edit` will not get far with the read-only default.

It is a real agent, not a chat box, so it has tools — and it is driven from a
web page. By default it **cannot write files, run commands, or spawn
subagents**:

```env
CLAUDE_JEV_AGENT_DENY="Write Edit NotebookEdit Bash PowerShell KillShell Task"
CLAUDE_JEV_AGENT_TOOLS="Read Glob Grep"
CLAUDE_JEV_AGENT_CWD=/path/to/project     # default: where claude-jev started
CLAUDE_JEV_AGENT_DIRS=C:ault;D:
otes   # extra writable roots, semicolon-separated
CLAUDE_JEV_CHAT=agent|api|off             # default: agent when `claude` is on PATH
```

The denylist is the boundary that matters. `--allowed-tools` **grants**
permissions, it does not confine them: with an allowlist of `Read Glob Grep`
the agent could still call `Write` and create a file. `--disallowed-tools`
refuses outright — "Write is disabled for this session, in subagents as well as
here" — which is why the default is expressed as a denylist.

There are three separate ways a turn can be blocked, each with its own fix:

| Symptom in chat | Cause | Fix |
|---|---|---|
| "*X* is disabled" | Tool is on the denylist | `CLAUDE_JEV_AGENT_DENY` |
| "Outside the agent's working directory" | Allowed tool, path outside the cwd | `CLAUDE_JEV_AGENT_DIRS` |
| "*X* is not in the chat agent's tool list" | Tool not granted | `CLAUDE_JEV_AGENT_TOOLS` |

The third catches people out: `Read Glob Grep` is a deliberately small default,
so web access, notebooks and anything else are simply absent. Web search is a
common addition:

```env
CLAUDE_JEV_AGENT_TOOLS=Read Glob Grep WebSearch WebFetch
```

`acceptEdits` auto-approves edits under the working directory, which is why
`Write` and `Edit` work there without being listed — but only there.

In every case the chat says which of the three it was and which variable to
change, rather than leaving the agent claiming it awaits a permission the
browser cannot give.

There is a second limit that is easy to mistake for a bug. `acceptEdits` only
auto-approves edits **inside the working directory**. Anywhere else the tool
comes back with "Claude requested permissions to write to ..., but you haven't
granted it yet" and the turn stalls on an approval the browser cannot give — a
skill that writes to a vault or notes folder hits this immediately. List those
folders in `CLAUDE_JEV_AGENT_DIRS`, separated by semicolons so Windows paths
with spaces survive. The chat names the blocked path when it happens.

To let the agent write or run commands, set `CLAUDE_JEV_AGENT_DENY=""` (or
narrow it) and add the tools to `CLAUDE_JEV_AGENT_TOOLS`. Do that only if you
accept that a page in your browser can then change files and run commands. When
a tool is blocked, the chat says which one and how to enable it, rather than
leaving the agent claiming it is waiting for a permission you cannot grant.

With `ANTHROPIC_API_KEY` set and no `claude` on PATH, chat falls back to calling
the API directly. Either way the proxy is required — without it a turn would be
neither routed nor recorded, so chat is switched off and says so rather than
quietly not being claude-jev. That is also why chat is unavailable under
`claude-jev dashboard`, which starts no proxy.

### Dashboard security

The dashboard binds to `127.0.0.1` only, sends no CORS headers, rejects any
request whose `Host` is not loopback (which defeats DNS rebinding), and requires
a per-process token that is embedded in the page when it is served. The token
matters because `/api/chat` spends money: without it, any page open in your
browser could post to the local port.

## Configuration

### Environment file

`claude-jev` reads `~/.claude-jev.env` on startup:

```env
JEV_API_KEY=sk-your-key-here
```

`TYPESAFE_API_KEY` also works. Without a key, `claude-jev` launches plain Claude Code with no routing.

### Override tier models

```env
CLAUDE_JEV_HAIKU_MODEL=claude-haiku-4-5-20251001
CLAUDE_JEV_SONNET_MODEL=claude-sonnet-5
CLAUDE_JEV_OPUS_MODEL=claude-opus-5
CLAUDE_JEV_HAIKU_EFFORT=null
CLAUDE_JEV_SONNET_EFFORT=high
CLAUDE_JEV_OPUS_EFFORT=high
```

### Reported model capabilities

Claude Code needs to know the context window and capabilities behind the `jev-auto` sentinel. It is told the **cheapest** tier's model, since any turn can route down to it and a request sized for a larger model is rejected upstream. If all your tiers share a context window, you can raise it:

```env
CLAUDE_JEV_BEHAVES_AS=claude-sonnet-5
```

### Other variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | Accepted instead of `ANTHROPIC_API_KEY` for the direct API chat backend |
| `CLAUDE_JEV_AGENT_PERMISSION` | Overrides the agent's `--permission-mode` (default `acceptEdits`) |
| `CLAUDE_JEV_LEDGER_PATH` | Moves `usage.jsonl` elsewhere — useful to keep test runs off your real ledger |
| `CLAUDE_JEV_UPLOAD_DIR` | Moves the pasted-image directory |
| `CLAUDE_JEV_STATE_PATH` | Moves the status-line state file |
| `JEV_DEBUG_PROMPTS` | `1` also logs prompt text. Off by default |

### Files written

| Path | Contents |
|---|---|
| `~/.claude-jev/usage.jsonl` | The usage ledger, 30-day retention |
| `~/.claude-jev/dashboard.url` | The dashboard URL, since the startup banner scrolls away |
| `~/.claude-jev/debug.log` | Only with `JEV_DEBUG=1`. Rotated at 5MB, keeping one generation |
| `~/.claude-jev/current.json` | The current routing decision, read by the status line |
| `~/.claude-jev/uploads/` | Images pasted into the chat, pruned after 24 hours |

### Debug mode

```bash
JEV_DEBUG=1 claude-jev
```

Logs every routing decision, Jev response time, confidence and token usage to
`~/.claude-jev/debug.log`, rotated at 5MB. Prompt **text** is not logged unless
you also set `JEV_DEBUG_PROMPTS=1` — debugging routing rarely needs the words,
and an unrotated transcript of everything you typed is not a good default.

## Deployment

### Install

```bash
git clone https://github.com/jly-engineer/claude-jev.git
cd claude-jev
npm install
npm link          # puts `claude-jev` on PATH, symlinked to this checkout
```

`npm link` symlinks rather than copies, so the global command always runs this
working tree. Pulling is the upgrade.

### Upgrading

```bash
cd /path/to/claude-jev
git pull
npm install       # only when dependencies changed
npm test          # 79 assertions, offline, ~300ms
```

Then **restart `claude-jev`**. Nothing is hot-reloaded:

- `src/*.mjs` is cached by Node for the life of the process
- `~/.claude-jev.env` is read once at launch into `process.env`
- the `modelPicker` sentinel settings file is written at launch
- the chat backend and `chatReady` are decided when the dashboard server starts

A running session keeps the old behaviour entirely, including old pricing.

### Configuration file

Everything lives in `~/.claude-jev.env` — on Windows, `C:\Users\<you>\.claude-jev.env`.
A complete example:

```env
JEV_API_KEY=sk-...
CLAUDE_JEV_AGENT_DENY=Bash PowerShell KillShell Task
CLAUDE_JEV_AGENT_DIRS=C:\Users\me\Documents\Knowledge Base;C:\Users\me\Documents\Leadership;D:\repos\work
```

**Multiple directories** go in one `CLAUDE_JEV_AGENT_DIRS` line separated by
semicolons. Not commas, not spaces, not repeated lines — a second line with the
same key wins and silently discards the first. Semicolons were chosen because
Windows paths contain spaces and a drive colon. Do not quote the whole value;
surrounding quotes are stripped from the line, not from each path. The working
directory is always writable, so it does not need listing.

> **Encoding trap.** Windows PowerShell's `Set-Content` and `>` write **UTF-16 LE**;
> PowerShell 7 writes UTF-8. The parser reads either, but not one file containing
> both — appending UTF-8 to a UTF-16 file corrupts it, taking your API key with it.
> Check the first two bytes (`255 254` means UTF-16 LE) and append in kind:
>
> ```powershell
> Add-Content ~\.claude-jev.env -Encoding Unicode -Value 'CLAUDE_JEV_AGENT_DIRS=C:\vault;D:\notes'
> ```
>
> Or convert the file to UTF-8 once and stop worrying about it.

Shell variables beat the file — the loader only fills in what is not already set,
so `$env:CLAUDE_JEV_CHAT='off'; claude-jev` overrides for a single run.

### Verifying a deployment

```bash
claude-jev savings --json      # ledger reachable, pricing sane
npm test                       # nothing broken offline
npm run test:routing           # routing accuracy (costs money — one Jev call per case)
```

With a session running, open the dashboard and read the composer hint under the
chat box. It states the agent's posture (`limited` or `⚠ writable`), its tool
list, and every directory it can write to. If that line disagrees with your env
file, the restart did not take.

### What runs where

| Piece | Lifetime | Notes |
|---|---|---|
| Proxy | With the session | Random loopback port |
| Dashboard | With the session | Port 3579, random fallback if taken |
| Chat agent | Per turn | A fresh `claude -p` child per message |
| Ledger | On disk | `~/.claude-jev/usage.jsonl`, 30-day retention, pruned at startup |
| Usage caps | In memory | Empty until the first response of a session |

The dashboard dies with the session. `claude-jev dashboard` serves the metrics
standalone but starts no proxy, so chat is unavailable there by design.

### Ledger notes

`claude-jev savings --reset` clears it. Worth doing after a pricing change:
events are costed when recorded, so old rows keep whatever rates were in force
and the dashboard blends them with current ones.

## Local API

The dashboard server exposes a small HTTP API on the same port. It exists for
the dashboard itself, but it is stable enough to script against.

**Every endpoint is same-origin only.** Requests are refused unless all three
hold:

1. The `Host` header is loopback (`127.0.0.1`, `localhost` or `[::1]`) on the
   serving port. This is what stops DNS rebinding — a hostname that resolves to
   127.0.0.1 still fails.
2. No CORS headers are sent at all, so a browser will not hand another origin
   the response.
3. `/api/*` requires a token, as `?t=<token>` or an `X-Jev-Token` header.

The token is 24 random bytes, generated per process and substituted into the
page when it is served. It is not persisted anywhere. Read it from the running
page:

```bash
TOKEN=$(curl -s http://127.0.0.1:3579/ | grep -oP 'const TOKEN = "\K[0-9a-f]+')
curl -s "http://127.0.0.1:3579/api/savings?t=$TOKEN" | jq .aggregated.month
```

The token matters because `/api/chat` spends money and can run tools. Without
it, any page open in your browser could post to the local port.

### Endpoints

| Method | Path | Returns |
|---|---|---|
| `GET` | `/` | Dashboard page |
| `GET` | `/chat` | Full-screen chat page |
| `GET` | `/api/savings` | Ledger events, aggregates, usage caps, chat status |
| `GET` | `/api/skills` | Slash commands for the typeahead |
| `POST` | `/api/upload` | Stores one pasted image, returns its path |
| `POST` | `/api/chat` | Runs one turn, streams SSE |
| `POST` | `/api/chat/reset` | Clears one conversation's history |

`GET /api/savings`:

```jsonc
{
  "events": [ { "ts": 0, "tier": "haiku", "inputTokens": 0, "outputTokens": 0,
                "cacheReadTokens": 0, "cost": 0, "baselineCost": 0 } ],
  "aggregated": { "today": {}, "week": {}, "month": {}, "byTier": {} },
  "usage":  { "fiveHour": { "utilization": 0.31, "resetAt": 0 }, "sevenDay": {} },
  "chatReady": true,
  "backend": "agent",           // or "api", or null when chat is off
  "agent": { "tools": "Read Glob Grep", "deny": "...", "writable": false,
             "cwd": "...", "dirs": [] }
}
```

`POST /api/chat` takes `{ "id": "<conversation>", "text": "<message>" }` and
replies with `text/event-stream`:

| Event | Payload |
|---|---|
| `backend` | Which backend ran, and the agent's tools, cwd and writable roots |
| `routed` | `tier`, `model`, and `confidence` on the API backend |
| `tool` | Name of a tool the agent invoked |
| `denied` | `reason` of `disabled`, `path` or `ungranted`, plus the tool or path |
| `delta` | A chunk of reply text |
| `done` | End of turn, with `costUsd` on the agent backend |
| `failed` | An error; the turn is over |

Status codes: `401` bad or missing token, `403` non-loopback `Host`, `400`
empty message, `503` chat unavailable, `404` unknown `/api/` path.

### Keep it local

The server binds to `127.0.0.1` and nothing else. Do not port-forward it, put a
reverse proxy in front of it, or expose 3579 through a tunnel. There is no user
authentication — the token identifies the browser tab, not a person, and anyone
who can reach the port and read the page can spend your quota and use whatever
tools the agent is configured with. It is a single-user, single-machine tool by
design.

## What leaves your machine, and what doesn't

**Your Claude Code credentials are never read, stored or logged.** The proxy
forwards the `authorization` header verbatim and keeps no copy of it. The chat
agent does not use that header at all: it spawns headless Claude Code, which
authenticates itself, which is how a Pro/Max subscription works here without an
API key. `ANTHROPIC_API_KEY` is only read for the fallback direct-API backend.

**Prompt text goes to two places.** Every user turn is sent to TypeSafe for
classification — that is what Jev does, and it is the whole mechanism. Turns
also go to Anthropic, as they would without this wrapper. Chat turns take the
same route.

**`JEV_DEBUG=1` does not log prompt text.** It records tiers, timings and token
counts to `~/.claude-jev/debug.log`, rotated at 5MB. Prompt text is written only
if you also set `JEV_DEBUG_PROMPTS=1`, which is off precisely because an
unrotated transcript of everything you typed is not something to turn on by
accident.

**The ledger holds no prompt text** — `~/.claude-jev/usage.jsonl` records
timestamps, tiers, token counts and costs only.

**Everything binds to loopback.** The proxy and the dashboard listen on
`127.0.0.1`, and the dashboard additionally refuses non-loopback `Host` headers
and requires a per-process token. See [Local API](#local-api) — and do not
expose either port beyond this machine.

**The chat agent can read files.** By default it can read anything under its
working directory; with `CLAUDE_JEV_AGENT_DIRS` or a relaxed
`CLAUDE_JEV_AGENT_DENY`, it can reach further and write. Those are your
settings to make deliberately.

## Project structure

```
bin/claude-jev.mjs      CLI launcher, env loading, subcommands
src/config.mjs          Tier table, Jev question, policy thresholds
src/router.mjs          Jev SDK integration + decide() policy
src/proxy.mjs           HTTP proxy, model rewrite, SSE token capture
src/pricing.mjs         Per-model token pricing
src/ledger.mjs          Append-only JSONL usage ledger
src/dashboard.mjs       Terminal savings renderer
src/usage-state.mjs     In-memory Claude usage cap state
src/web-server.mjs      Dashboard HTTP server
src/web-dashboard.html  Dashboard UI (metrics)
src/web-chat.html       Full-screen chat UI (/chat) with slash autocomplete
src/skills.mjs          Slash-command discovery for the typeahead
src/chat.mjs            Direct-API chat path (tier selection + history)
src/agent.mjs           Headless Claude Code chat path (subscription, tools)
src/env.mjs             ~/.claude-jev.env loader (handles UTF-16)
test/unit/              Offline unit suite (npm test)
test/routing/           Routing accuracy cases + runner (npm run test:routing)
```

## Tests

```bash
npm test                  # unit suite — free, offline, no API keys
npm run test:routing      # routing accuracy against 25 labelled prompts (costs money)
```

The unit suite runs on `node:test` with no network. The routing suite makes one
live Jev call per case and exits non-zero below 85% accuracy — run it when you
change the tier guidance in `src/config.mjs`. See [`test/README.md`](test/README.md).

## Known issues

- **Per-turn chat cost is not reconciled.** The ledger records what the proxy
  observed for each request; Claude Code reports a session total including its
  own overhead. The two do not match for a single chat turn. Aggregate savings
  are unaffected.
- **Ledger pruning assumes one session.** `prune()` runs at startup and is
  atomic against readers, but a second `claude-jev` starting while the first is
  writing can lose events appended in that window.
- **Chat history is per page load.** Reloading `/chat` starts a new
  conversation; the previous one is not resumable from the UI.
- **Usage caps are in memory.** They are empty until the first response of a
  session and are not persisted across restarts.
- **Token capture needs plaintext SSE.** `accept-encoding` is stripped from
  upstream requests so the usage parser can read the stream. If the API ever
  requires compression, this needs a decompression step.
- **The dashboard dies with the session.** It shares a process with the proxy.
  `claude-jev dashboard` serves the metrics standalone, but starts no proxy, so
  chat is unavailable there.

## Requirements

- Node.js 20+
- [Claude Code](https://code.claude.com/docs/en/setup) installed
- A [TypeSafe Jev API key](https://console.typesafe.ai/keys) (free)

## License

MIT
