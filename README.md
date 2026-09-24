# claude-jev

**A live dashboard and a full-screen Claude Code agent in your browser — with every prompt auto-routed to the cheapest model that can handle it.**

Built by [**joetechninja**.com](https://joetechninja.com) — workflow automation and AI consulting.

---

## The dashboard

Runs at **http://127.0.0.1:3579** alongside every session.

- **What you saved**, against running everything on Opus — today, 7 days, 30 days
- **Usage caps** — your 5-hour and weekly limits with reset times
- **Where the work went** — requests, tokens and cost per tier
- **Recent requests**, each with its tier and what it actually cost

## The chat

A full Claude Code agent at **/chat**, not a chat box.

- **Works on a Pro/Max subscription** — no API key. It spawns headless Claude Code, which authenticates itself
- **Type `/`** to autocomplete your skills, project commands and plugins
- **Paste or drop images** straight into the composer
- **Tools, read-only by default** — it can read your code, and write only where you let it
- Every turn is routed by Jev and lands in the dashboard beside it

## The routing

A typo fix goes to Haiku. A standard implementation goes to Sonnet. Unknown-cause debugging goes to Opus. You don't pick — [Jev](https://docs.typesafe.ai) decides in ~200ms for a fraction of a cent, and the proxy rewrites the model before the request leaves your machine.

```
you → claude (real CLI, real UI) → claude-jev proxy → api.anthropic.com
                                        └→ Jev: which tier fits this prompt?
```

Claude Code itself is untouched — tools, keybindings, `/compact`, `/resume`, sessions. Only the model changes, and the current tier shows in the status line.

> `claude-jev` launches Claude Code with `--dangerously-skip-permissions`. Tool calls run without asking. Use it where that's acceptable.

---

## Quickstart

Paste this into Claude Code, Cursor, or any coding agent, and it will install and configure everything:

```
Install claude-jev from https://github.com/jly-engineer/claude-jev and set it up for me.

1. Check `node --version` is 20 or newer. If not, stop and tell me how to upgrade
   on my OS (on Ubuntu, apt's nodejs is too old — use nvm or NodeSource).
2. Check `claude --version` works. If not, stop and point me at
   https://code.claude.com/docs/en/setup
3. Clone the repo to ~/src/claude-jev (on Windows, %USERPROFILE%\src\claude-jev),
   run `npm install`, then `npm link`.
   If npm link fails with EACCES, do not use sudo — set a user prefix instead:
   `npm config set prefix ~/.npm-global` and add ~/.npm-global/bin to my PATH.
4. Ask me for my TypeSafe Jev key (free from https://console.typesafe.ai/keys)
   and write it to ~/.claude-jev.env as JEV_API_KEY=...
   On Windows that file must be UTF-16 or UTF-8 consistently — never append
   UTF-8 to a UTF-16 file, it corrupts the key.
5. Run `npm test` and confirm it passes.
6. Tell me to run `claude-jev`, and that the dashboard is at
   http://127.0.0.1:3579 with chat at /chat.

Read the repo's README for configuration options. Do not change my existing
Claude Code settings.
```

### Or install it yourself

```bash
git clone https://github.com/jly-engineer/claude-jev.git ~/src/claude-jev
cd ~/src/claude-jev
npm install
npm link
echo "JEV_API_KEY=sk-your-key-here" > ~/.claude-jev.env
claude-jev
```

Needs **Node 20+**, [Claude Code](https://code.claude.com/docs/en/setup) on your `PATH`, and a free [Jev key](https://console.typesafe.ai/keys). `npm link` symlinks the checkout, so `git pull` is the upgrade.

The checkout lives at `~/src/claude-jev` on every OS — `%USERPROFILE%\src\claude-jev` on Windows, where `~` also works in PowerShell. Only the `claude-jev` command's own location varies, because npm puts it wherever your Node install keeps global packages; `npm ls -g claude-jev` shows where it points.

### Linux and macOS

Fully supported. Two things specific to **Ubuntu 24.04**:

- `apt install nodejs` gives Node 18 — too old. Use [nvm](https://github.com/nvm-sh/nvm) or [NodeSource](https://deb.nodesource.com).
- With a system-wide Node, `npm link` wants `sudo`. Don't. Set a user prefix:
  ```bash
  npm config set prefix ~/.npm-global
  echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc && exec $SHELL
  ```
  With nvm, neither applies.

`xdg-open` is only used to open a browser; headless it does nothing and the URL still prints to `~/.claude-jev/dashboard.url`.

### Updating

On any OS (PowerShell works too):

```bash
cd ~/src/claude-jev
git pull
npm install
npm test
```

No need to re-run `npm link` — the global `claude-jev` already points at the checkout. `npm install` only matters when dependencies change, but is safe every time.

Then quit any running `claude-jev` and start it again. Nothing reloads in place: code, `~/.claude-jev.env` and the generated settings file are all read at launch.

If `git pull` refuses because of local changes, check `git diff`. A mode-only change on `bin/claude-jev.mjs` (`old mode 100644` / `new mode 100755`) comes from `npm link` on checkouts older than the fix; `git checkout bin/claude-jev.mjs`, pull, then `chmod +x bin/claude-jev.mjs`. Don't set `core.fileMode false` — a pull can then drop the executable bit silently, and `claude-jev` fails with `Permission denied`.

Can't find the checkout? `npm ls -g claude-jev` prints where the link points.

---

## Configuring the chat agent

It has tools and runs from a web page, so by default it **cannot write files, run commands, or spawn subagents**:

```env
CLAUDE_JEV_AGENT_DENY="Write Edit NotebookEdit Bash PowerShell KillShell Task"
CLAUDE_JEV_AGENT_TOOLS="Read Glob Grep"
CLAUDE_JEV_AGENT_DIRS=""            # extra writable roots, ; separated
CLAUDE_JEV_AGENT_CWD=""             # default: where claude-jev started
```

**The denylist is the boundary that matters.** `--allowed-tools` grants permissions, it does not confine them — with an allowlist of `Read Glob Grep` the agent could still call `Write`. `--disallowed-tools` refuses outright.

Common adjustments:

| Want | Set |
|---|---|
| Web search | `CLAUDE_JEV_AGENT_TOOLS="Read Glob Grep WebSearch WebFetch"` |
| Edit files, no shell | `CLAUDE_JEV_AGENT_DENY="Bash PowerShell KillShell Task"` |
| Reach a notes folder | `CLAUDE_JEV_AGENT_DIRS="/path/to/vault;/path/to/notes"` |
| Anything at all | `CLAUDE_JEV_AGENT_DENY=""` — a web page can then run commands |

Three different things can block a turn, and the chat tells you which:

| Message | Fix |
|---|---|
| *X is disabled* | `CLAUDE_JEV_AGENT_DENY` |
| *Outside the working directory* | `CLAUDE_JEV_AGENT_DIRS` |
| *X is not in the tool list* | `CLAUDE_JEV_AGENT_TOOLS` |

Edits are auto-approved only **inside** the working directory. Anywhere else the tool stalls on an approval a browser cannot give — which is what `CLAUDE_JEV_AGENT_DIRS` is for. Separated by `;` on every platform, since Windows paths contain spaces and a drive colon.

Without a `claude` CLI but with `ANTHROPIC_API_KEY` set, chat falls back to calling the API directly. Either way the proxy is required, so chat is unavailable under `claude-jev dashboard`.

---

## Savings in the terminal

```bash
claude-jev savings              # the dashboard below
claude-jev savings --json       # machine-readable
claude-jev savings --days 7     # narrower window
claude-jev savings --reset      # clear the ledger
```

```
  ⚡ claude-jev savings  vs always using Opus 5
  ─────────────────────────────────────────────────────────────────

  Today          █████████░░░░░░░░░░░ 46.7% saved  62.1k new  $0.41 saved  (5 reqs)
  Last 7 days    █████████░░░░░░░░░░░ 46.7% saved  62.1k new  $0.41 saved  (5 reqs)
  Last 30 days   █████████░░░░░░░░░░░ 46.7% saved  62.1k new  $0.41 saved  (5 reqs)

  ─────────────────────────────────────────────────────────────────
  Cost breakdown by tier:

  haiku       3 reqs    15.8k new     $0.21 saved  (actual: $0.05)
  sonnet      1 reqs    33.3k new     $0.20 saved  (actual: $0.13)
  opus        1 reqs    13.0k new     $0.00 saved  (actual: $0.28)

  ─────────────────────────────────────────────────────────────────
  Total:  62.1k new tokens across 5 requests
           540.0k cached (prefix re-reads, billed at a tenth)
  Actual cost:     $0.46
  Opus 5 would be: $0.87
  You saved:       $0.41  (46.7%)
```

### Why "new" and "cached" are separate

The API is stateless, so every request re-sends the whole conversation; caching serves that prefix at a tenth of the input rate. One chat turn is several requests, and each one's cache read is roughly the previous request's entire input.

Summing raw input therefore counts the same conversation over and over — a real ledger read **5.7M "tokens" against 764k of actual new content**, for the same $1.84. So the dashboards lead with new tokens. Costs were always right; only the token column misled.

---

## Configuration

Everything lives in `~/.claude-jev.env`.

| Variable | Purpose |
|---|---|
| `JEV_API_KEY` / `TYPESAFE_API_KEY` | Jev key. Required for routing |
| `ANTHROPIC_API_KEY` | Fallback chat backend only. Not needed on a subscription |
| `CLAUDE_JEV_<TIER>_MODEL` | Override a tier's model |
| `CLAUDE_JEV_<TIER>_EFFORT` | Override a tier's effort |
| `CLAUDE_JEV_BEHAVES_AS` | Model the sentinel reports as. Default: cheapest tier |
| `CLAUDE_JEV_CHAT` | `agent` (default) / `api` / `off` |
| `CLAUDE_JEV_AGENT_*` | See [Configuring the chat agent](#configuring-the-chat-agent) |
| `CLAUDE_JEV_STATUSLINE` | `1` force ours, `0` never. Default: only if you have none |
| `CLAUDE_JEV_LEDGER_PATH` · `CLAUDE_JEV_UPLOAD_DIR` · `CLAUDE_JEV_STATE_PATH` | Relocate state |
| `JEV_DEBUG` | `1` logs decisions to `~/.claude-jev/debug.log`, rotated at 5MB |
| `JEV_DEBUG_PROMPTS` | `1` also logs prompt text. Off by default |

> **Windows:** PowerShell writes UTF-16, PowerShell 7 writes UTF-8. The parser reads either — but never append one to the other, it corrupts the file and takes your key with it. Append with `Add-Content -Encoding Unicode` to a UTF-16 file.

Shell variables win over the file, so `CLAUDE_JEV_CHAT=off claude-jev` overrides for one run. **Nothing hot-reloads** — restart after editing.

### Routing tiers

| Tier | Model | When |
|---|---|---|
| **haiku** | `claude-haiku-4-5-20251001` | Typos, renames, lookups, mechanical edits |
| **sonnet** | `claude-sonnet-5` | Implementations, tests, known bug fixes |
| **opus** | `claude-opus-5` | Unknown-cause debugging, multi-module design, security |

Every error path keeps the current model: Jev unreachable or slow → no change; confidence below 0.6 → never downgrade, upgrades capped at sonnet; tool continuations → untouched.

### Status line

```
⚡ haiku→sonnet p=0.92  ·  $5.77 saved today · 76%
```

The proxy prints nothing to your terminal. The decision goes to `~/.claude-jev/current.json` and renders in Claude Code's status line. **If you already have one, yours is kept** — ours is only added when none is configured.

### Files written

| Path | Contents |
|---|---|
| `~/.claude-jev/usage.jsonl` | Usage ledger, 30-day retention |
| `~/.claude-jev/current.json` | Current routing decision |
| `~/.claude-jev/dashboard.url` | Dashboard URL |
| `~/.claude-jev/uploads/` | Pasted images, pruned after 24h |
| `~/.claude-jev/debug.log` | Only with `JEV_DEBUG=1` |

---

## Local API

Same-origin only, three ways: loopback `Host` allowlist (defeats DNS rebinding), no CORS headers, and a per-process token substituted into the page. The token matters because `/api/chat` spends money.

```bash
TOKEN=$(curl -s http://127.0.0.1:3579/ | grep -oP 'const TOKEN = "\K[0-9a-f]+')
curl -s "http://127.0.0.1:3579/api/savings?t=$TOKEN" | jq .aggregated.month
```

| Method | Path | Returns |
|---|---|---|
| `GET` | `/` · `/chat` | Dashboard · chat page |
| `GET` | `/api/savings` | Events, aggregates, usage caps, chat status |
| `GET` | `/api/skills` | Slash commands for the typeahead |
| `POST` | `/api/upload` | Stores one pasted image, returns its path |
| `POST` | `/api/chat` | Runs one turn, streams SSE |
| `POST` | `/api/chat/reset` | Clears one conversation |

`/api/chat` streams `backend`, `routed`, `tool`, `denied`, `delta`, `done` and `failed` events. Status codes: `401` bad token, `403` non-loopback Host, `400` empty message, `503` chat unavailable.

**Keep it local.** There is no user authentication — the token identifies a browser tab, not a person. Don't port-forward, reverse-proxy or tunnel this port.

---

## What leaves your machine

- **Your Claude Code credentials are never read, stored or logged.** The proxy forwards the `authorization` header verbatim and keeps no copy. The chat agent doesn't use it at all — headless Claude Code authenticates itself.
- **Prompt text goes to TypeSafe** for classification (that's the mechanism) and to Anthropic, as it would anyway.
- **The ledger holds no prompt text** — timestamps, tiers, token counts, costs.
- **`JEV_DEBUG=1` does not log prompt text** unless you also set `JEV_DEBUG_PROMPTS=1`.
- **Everything binds to `127.0.0.1`.**

---

## Tests

```bash
npm test                  # 103 assertions, offline, no API keys, ~400ms
npm run test:routing      # routing accuracy, 25 cases — costs money
```

The routing suite makes one live Jev call per case and exits non-zero below 85%. Run it when you change tier guidance in `src/config.mjs`. See [`test/README.md`](test/README.md).

## Known issues

- **Per-turn chat cost isn't reconciled.** The ledger records per request; Claude Code reports a session total including its own overhead. Aggregates are unaffected.
- **Ledger pruning assumes one session.** A second `claude-jev` starting while the first writes can lose events in that window.
- **Chat history is per page load.** Reloading `/chat` starts a new conversation.
- **Usage caps are in memory** — empty until the first response of a session.
- **Token capture needs plaintext SSE.** `accept-encoding` is stripped upstream so the usage parser can read the stream.
- **The dashboard dies with the session.** `claude-jev dashboard` serves metrics standalone, but starts no proxy, so chat is unavailable there.

## Project structure

```
bin/claude-jev.mjs      CLI launcher, subcommands
bin/statusline.mjs      Status line renderer
src/config.mjs          Tier table, Jev question, thresholds
src/router.mjs          Jev client + decide() policy
src/proxy.mjs           HTTP proxy, model rewrite, usage capture
src/pricing.mjs         Per-model and cache pricing
src/ledger.mjs          Append-only JSONL ledger
src/state.mjs           Current decision, for the status line
src/agent.mjs           Headless Claude Code chat backend
src/chat.mjs            Direct-API chat backend
src/skills.mjs          Slash-command discovery
src/uploads.mjs         Pasted image storage
src/web-server.mjs      HTTP server and API
src/web-dashboard.html  Dashboard UI
src/web-chat.html       Full-screen chat UI
src/dashboard.mjs       Terminal savings renderer
src/env.mjs             ~/.claude-jev.env loader
test/                   Unit suite + routing accuracy cases
```

Deployment and upgrade notes: [`CLAUDE.md`](CLAUDE.md).

---

[**joetechninja**.com](https://joetechninja.com)

## License

MIT
