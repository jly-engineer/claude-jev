import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { captureFromRateLimitEvent } from "./usage-state.mjs";
import { AUTO_MODEL } from "./config.mjs";
import { adoptSlashCommands } from "./skills.mjs";

/**
 * Chat backed by headless Claude Code.
 *
 * `claude -p` is spawned with ANTHROPIC_BASE_URL pointed at our own proxy and
 * the jev-auto sentinel as the model, so the turn is routed by Jev and lands
 * in the ledger exactly like an interactive turn. The child authenticates
 * itself, which is the point: a Claude Pro/Max subscription works here,
 * because the thing making the request genuinely is Claude Code. We never see
 * or store the credential.
 *
 * It is a real agent, not a chat box — it has tools, and it is driven from a
 * browser page.
 *
 * The safety boundary is --disallowed-tools, NOT --allowed-tools. An allowlist
 * grants; it does not confine. With --permission-mode acceptEdits, passing
 * "--allowed-tools Read Glob Grep" still let the agent call Write and create a
 * file. A denylist is refused outright ("No such tool available: Write. Write
 * is disabled for this session, in subagents as well as here"), which is what
 * we actually want. Change DEFAULT_DENY only with that in mind.
 */

const DEFAULT_TOOLS = "Read Glob Grep";
const DEFAULT_DENY = "Write Edit NotebookEdit Bash PowerShell KillShell Task";

export function agentConfig() {
  // An explicit empty value means "deny nothing" — a deliberate opt-in to a
  // writable agent, not an accident.
  const deny = process.env.CLAUDE_JEV_AGENT_DENY ?? DEFAULT_DENY;
  return {
    tools: (process.env.CLAUDE_JEV_AGENT_TOOLS ?? DEFAULT_TOOLS).trim(),
    deny: deny.trim(),
    writable: deny.trim() === "",
    cwd: process.env.CLAUDE_JEV_AGENT_CWD || process.cwd(),
    // acceptEdits only auto-approves edits inside the working directory.
    // Anywhere else the tool stalls waiting for a permission the browser
    // cannot grant, so extra roots have to be declared up front. Separated by
    // ";" because Windows paths contain spaces and drive colons.
    dirs: (process.env.CLAUDE_JEV_AGENT_DIRS || "").split(";").map((d) => d.trim()).filter(Boolean),
    permissionMode: process.env.CLAUDE_JEV_AGENT_PERMISSION || "acceptEdits",
  };
}

let cached;
/** Locate the claude CLI, preferring a spawnable binary on Windows. */
export function findClaude() {
  if (cached !== undefined) return cached;
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const lines = execSync(`${which} claude`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split(/\r?\n/).filter(Boolean);
    cached = process.platform === "win32"
      ? (lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.cmd$/i.test(l)) ?? lines[0] ?? null)
      : (lines[0] ?? null);
  } catch {
    cached = null;
  }
  return cached;
}

export const agentAvailable = () => Boolean(findClaude());

/** A fresh conversation id. Reused across turns via --resume. */
export const newAgentSession = () => randomUUID();

/**
 * Classify a failed tool_result into *why* the agent was blocked.
 *
 * Three states, three different remedies, and Claude Code words each one
 * differently — so the matching lives in one place and is tested:
 *
 *   disabled   on --disallowed-tools        fix: CLAUDE_JEV_AGENT_DENY
 *   path       allowed tool, cwd-external   fix: CLAUDE_JEV_AGENT_DIRS
 *   ungranted  not in --allowed-tools       fix: CLAUDE_JEV_AGENT_TOOLS
 *
 * Returns null for an ordinary tool failure. Getting this wrong is not
 * cosmetic: an unrecognised denial leaves the agent insisting it is waiting
 * for a permission the browser has no way to grant.
 */
export function detectDenial(body) {
  if (typeof body !== "string" || !body) return null;

  const off = /No such tool available: (\w+)|(\w+) is disabled for this session/.exec(body);
  if (off) return { reason: "disabled", name: off[1] || off[2] };

  // "...requested permissions to write to <path>, but you haven't granted..."
  const scope = /requested permissions? to \w+ to (.+?), but you haven't granted/.exec(body);
  if (scope) return { reason: "path", path: scope[1] };

  // "...requested permissions to use <Tool>, but you haven't granted..."
  const ungranted = /requested permissions? to use (\w+)/.exec(body);
  if (ungranted) return { reason: "ungranted", name: ungranted[1] };

  return null;
}

/**
 * Build the CLI arguments for one turn. Exported so the safety flags can be
 * asserted without spawning anything.
 */
export function buildArgs({ prompt, sessionId, started, settingsFile }) {
  const { tools, deny, dirs, permissionMode } = agentConfig();
  return [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", permissionMode,
    // First turn opens the session; later turns continue it.
    ...(started ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ...(tools ? ["--allowed-tools", ...tools.split(/\s+/)] : []),
    // The actual boundary. See the note at the top of this file.
    ...(deny ? ["--disallowed-tools", ...deny.split(/\s+/)] : []),
    ...(dirs.length ? ["--add-dir", ...dirs] : []),
    ...(settingsFile ? ["--settings", settingsFile] : []),
  ];
}

/**
 * Run one turn. Calls `onEvent` with:
 *   { kind: "routed", model }      the model the child reported using
 *   { kind: "delta", text }        assistant text
 *   { kind: "tool", name }         a tool the agent invoked
 *   { kind: "failed", error }
 *   { kind: "done", costUsd, sessionId }
 *
 * @returns {Promise<{ sessionId: string, text: string }>}
 */
export function runAgentTurn({ prompt, sessionId, started, proxyPort, settingsFile }, onEvent) {
  const claudePath = findClaude();
  if (!claudePath) return Promise.reject(new Error("claude CLI not found on PATH"));

  const { cwd } = agentConfig();
  const args = buildArgs({ prompt, sessionId, started, settingsFile });

  const env = { ...process.env, ANTHROPIC_MODEL: AUTO_MODEL };
  if (proxyPort) env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  // The child must not inherit our own session's identity.
  delete env.CLAUDE_CODE_SESSION_ID;

  const isCmd = /\.cmd$/i.test(claudePath);
  const child = spawn(claudePath, args, { cwd, env, shell: isCmd, stdio: ["ignore", "pipe", "pipe"] });

  return new Promise((resolve, reject) => {
    let buf = "";
    let text = "";
    let costUsd = null;
    let resolvedSession = sessionId;
    let stderr = "";
    const seenDenials = new Set();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt;
        try { evt = JSON.parse(trimmed); } catch { continue; }
        handle(evt);
      }
    });

    function handle(evt) {
      // Utilization arrives here as a stream event. This is a better source
      // than sniffing anthropic-ratelimit-unified-* response headers, which
      // only show up for subscription logins and not on every response.
      if (evt.type === "rate_limit_event" && evt.rate_limit_info) {
        captureFromRateLimitEvent(evt.rate_limit_info);
        return;
      }
      // Claude Code's own list of slash commands, free on every turn. It
      // knows plugin namespacing and precedence; our scan only knows prose.
      if (evt.type === "system" && evt.subtype === "init" && evt.slash_commands) {
        adoptSlashCommands(evt.slash_commands);
      }
      if (evt.session_id) resolvedSession = evt.session_id;

      if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
        if (evt.message.model) onEvent({ kind: "routed", model: evt.message.model });
        for (const block of evt.message.content) {
          if (block.type === "text" && block.text) {
            text += block.text;
            onEvent({ kind: "delta", text: block.text });
          } else if (block.type === "tool_use") {
            onEvent({ kind: "tool", name: block.name });
          }
        }
        return;
      }
      // A blocked tool comes back as an errored tool_result, not an event of
      // its own. Without this the agent just says it needs permission and the
      // browser has no way to grant it — a dead end with no explanation.
      if (evt.type === "user" && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (block?.type !== "tool_result" || !block.is_error) continue;
          const body = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          if (block.tool_use_id) seenDenials.add(block.tool_use_id);
          const denial = detectDenial(body);
          if (denial) onEvent({ kind: "denied", ...denial });
        }
        return;
      }
      // The final line carries cost and stop_reason but has no `type`. It also
      // carries permission_denials as structured data — more dependable than
      // matching prose, and a backstop if the wording ever changes.
      if (Array.isArray(evt.permission_denials)) {
        for (const d of evt.permission_denials) {
          if (!d?.tool_name || seenDenials.has(d.tool_use_id)) continue;
          seenDenials.add(d.tool_use_id);
          const path = d.tool_input?.file_path;
          onEvent(path
            ? { kind: "denied", reason: "path", path, name: d.tool_name }
            : { kind: "denied", reason: "ungranted", name: d.tool_name });
        }
      }
      if (typeof evt.total_cost_usd === "number") costUsd = evt.total_cost_usd;
      if (evt.type === "result" && evt.is_error) {
        onEvent({ kind: "failed", error: String(evt.result ?? "agent error") });
      }
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { stderr += c; });

    child.on("error", reject);
    child.on("close", (code) => {
      if (buf.trim()) { try { handle(JSON.parse(buf.trim())); } catch { /* partial */ } }
      if (code !== 0 && !text) {
        reject(new Error(stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400) || `claude exited ${code}`));
        return;
      }
      onEvent({ kind: "done", costUsd, sessionId: resolvedSession });
      resolve({ sessionId: resolvedSession, text });
    });
  });
}
