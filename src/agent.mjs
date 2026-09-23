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
 * It is a real agent, not a chat box — it has tools. The default tool set is
 * read-only, because this is driven from a browser page. Widen it deliberately
 * with CLAUDE_JEV_AGENT_TOOLS if that is what you want.
 */

const DEFAULT_TOOLS = "Read Glob Grep";

export function agentConfig() {
  return {
    tools: (process.env.CLAUDE_JEV_AGENT_TOOLS ?? DEFAULT_TOOLS).trim(),
    cwd: process.env.CLAUDE_JEV_AGENT_CWD || process.cwd(),
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

  const { tools, cwd, permissionMode } = agentConfig();
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", permissionMode,
    // First turn opens the session; later turns continue it.
    ...(started ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ...(tools ? ["--allowed-tools", ...tools.split(/\s+/)] : []),
    ...(settingsFile ? ["--settings", settingsFile] : []),
  ];

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
      // The final line carries cost and stop_reason but has no `type`.
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
