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
| **opus** | `claude-opus-4-6` | Unknown-cause debugging, multi-module design, security logic |

### Fail-open design

Every error path keeps the current model:

- Jev unreachable or times out -> keep current tier
- Low confidence (<0.6) -> never downgrade, cap upgrades at sonnet
- Non-routed requests (user picked a model, tool continuations) -> pass through untouched

### Model switch animation

When Jev switches tiers, you see an animated transition in the terminal:

```
  ◐ haiku
  ◑ ━━━╸┄┄┄┄ opus
  ⚡ haiku -> opus (claude-opus-4-6) p=0.92
```

Color-coded: haiku = green, sonnet = yellow, opus = magenta.

## Savings dashboard

Track what you're saving compared to running everything on Opus 4.6.

### Terminal

```bash
claude-jev savings              # headroom-style terminal dashboard
claude-jev savings --json       # machine-readable output
claude-jev savings --days 7     # restrict lookback window (1-30)
claude-jev savings --reset      # clear the ledger
```

```
  ⚡ claude-jev savings  vs always using Opus 4.6
  ─────────────────────────────────────────────────────────────────

  Today          ██████████████░░░░░░ 69.2% saved  66.0k tokens  $1.51 saved  (5 reqs)
  Last 7 days    ██████████████░░░░░░ 69.2% saved  66.0k tokens  $1.51 saved  (5 reqs)
  Last 30 days   ██████████████░░░░░░ 69.2% saved  66.0k tokens  $1.51 saved  (5 reqs)

  Cost breakdown by tier:

  haiku       3 reqs    39.0k tokens     $1.18 saved  (actual: $0.07)
  sonnet      1 reqs    12.0k tokens     $0.34 saved  (actual: $0.08)
  opus        1 reqs    15.0k tokens     $0.00 saved  (actual: $0.53)
```

### Web dashboard

A live web dashboard runs automatically alongside every `claude-jev` session at **http://127.0.0.1:3579**. Or launch it standalone:

```bash
claude-jev dashboard    # opens browser to http://127.0.0.1:3579
```

Features:
- **Chat** — a full-screen Claude Code agent at `/chat`, routed by Jev, works on a Pro subscription
- **Summary cards** — You Saved / Actual Spend / Opus 4.6 Would Be
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
CLAUDE_JEV_CHAT=agent|api|off             # default: agent when `claude` is on PATH
```

The denylist is the boundary that matters. `--allowed-tools` **grants**
permissions, it does not confine them: with an allowlist of `Read Glob Grep`
the agent could still call `Write` and create a file. `--disallowed-tools`
refuses outright — "Write is disabled for this session, in subagents as well as
here" — which is why the default is expressed as a denylist.

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
CLAUDE_JEV_OPUS_MODEL=claude-opus-4-6
CLAUDE_JEV_HAIKU_EFFORT=null
CLAUDE_JEV_SONNET_EFFORT=high
CLAUDE_JEV_OPUS_EFFORT=high
```

### Reported model capabilities

Claude Code needs to know the context window and capabilities behind the `jev-auto` sentinel. It is told the **cheapest** tier's model, since any turn can route down to it and a request sized for a larger model is rejected upstream. If all your tiers share a context window, you can raise it:

```env
CLAUDE_JEV_BEHAVES_AS=claude-sonnet-5
```

### Debug mode

```bash
JEV_DEBUG=1 claude-jev
```

Logs every routing decision, Jev response time, confidence, and token usage to stderr.

## How credentials are handled

Your Claude Code credentials are never read, stored, or logged. The proxy forwards the `authorization` header verbatim and keeps no copy — which is also why the dashboard chat cannot reuse them and needs its own `ANTHROPIC_API_KEY`. The only data sent to Jev is the text of the user's latest turn for classification. The proxy listens on `127.0.0.1` only.

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

## Requirements

- Node.js 20+
- [Claude Code](https://code.claude.com/docs/en/setup) installed
- A [TypeSafe Jev API key](https://console.typesafe.ai/keys) (free)

## License

MIT
