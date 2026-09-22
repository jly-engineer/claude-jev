import http from "node:http";
import https from "node:https";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { isAuto, AUTO_MODEL, tierSpec, TIER_NAMES } from "./config.mjs";
import { askJev, decide } from "./router.mjs";
import { record } from "./ledger.mjs";
import { cost, baselineCost } from "./pricing.mjs";
import { captureFromHeaders } from "./usage-state.mjs";

const UPSTREAM = "api.anthropic.com";
const LOG_FILE = process.env.JEV_DEBUG
  ? join(homedir(), ".claude-jev", "debug.log")
  : null;

function log(msg) {
  if (!LOG_FILE) return;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    process.stderr.write(`[claude-jev] ${msg}\n`);
  }
}

// ── Tier colors ─────────────────────────────────────────────────────────────
const TIER_COLOR = {
  haiku:  "\x1b[32m",   // green
  sonnet: "\x1b[33m",   // yellow
  opus:   "\x1b[35m",   // magenta
};
const BOLD = "\x1b[1m";
const DIM  = "\x1b[2m";
const RST  = "\x1b[0m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE  = "\x1b[2K\r";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SWITCH_FRAMES = ["◐", "◓", "◑", "◒"];

/**
 * Animate a model-switch transition on stderr.
 * ~600ms total — fast enough to not block, visible enough to notice.
 */
function animateSwitch(fromTier, toTier, spec, confidence) {
  const w = process.stderr;
  if (!w.isTTY) {
    // No animation for non-TTY — just print the result
    const c = TIER_COLOR[toTier] ?? "\x1b[36m";
    w.write(`${c}⚡ jev → ${BOLD}${toTier}${RST}${c} (${spec?.id})${RST}` +
      (confidence != null ? ` p=${confidence.toFixed(2)}` : "") + "\n");
    return Promise.resolve();
  }

  const fromColor = TIER_COLOR[fromTier] ?? "\x1b[36m";
  const toColor   = TIER_COLOR[toTier]   ?? "\x1b[36m";
  const changed   = fromTier !== toTier;

  return new Promise((resolve) => {
    w.write(HIDE_CURSOR);
    let frame = 0;
    const totalFrames = changed ? 12 : 6;
    const interval = setInterval(() => {
      if (frame < totalFrames) {
        if (changed && frame < 6) {
          // Phase 1: spin away from old model
          const s = SWITCH_FRAMES[frame % SWITCH_FRAMES.length];
          w.write(`${CLEAR_LINE}${fromColor}${DIM}  ${s} ${fromTier}${RST}`);
        } else if (changed) {
          // Phase 2: spin into new model
          const s = SWITCH_FRAMES[frame % SWITCH_FRAMES.length];
          const progress = "━".repeat(frame - 5) + "╸" + "┄".repeat(totalFrames - frame);
          w.write(`${CLEAR_LINE}${toColor}  ${s} ${progress} ${BOLD}${toTier}${RST}`);
        } else {
          // No change: just a quick thinking spinner
          const s = SPINNER[frame % SPINNER.length];
          w.write(`${CLEAR_LINE}${toColor}  ${s} routing...${RST}`);
        }
        frame++;
      } else {
        clearInterval(interval);
        // Final line
        const arrow = changed
          ? `${fromColor}${DIM}${fromTier}${RST} → ${toColor}${BOLD}${toTier}${RST}`
          : `${toColor}${BOLD}${toTier}${RST}`;
        const conf = confidence != null ? ` ${DIM}p=${confidence.toFixed(2)}${RST}` : "";
        const model = `${DIM}(${spec?.id})${RST}`;
        w.write(`${CLEAR_LINE}${toColor}  ⚡${RST} ${arrow} ${model}${conf}\n`);
        w.write(SHOW_CURSOR);
        resolve();
      }
    }, 50);
  });
}

/** Quick banner for same-tier (no switch). */
function printStatic(tier, spec, confidence) {
  const c = TIER_COLOR[tier] ?? "\x1b[36m";
  const conf = confidence != null ? ` ${DIM}p=${confidence.toFixed(2)}${RST}` : "";
  process.stderr.write(
    `${c}  ⚡${RST} ${c}${BOLD}${tier}${RST} ${DIM}(${spec?.id})${RST}${conf}\n`,
  );
}

/**
 * Extract the user's latest turn text from a Claude API request body.
 * Returns null for tool-loop continuations and auxiliary calls.
 */
function extractPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null;
  const messages = body?.messages;
  if (!Array.isArray(messages)) return null;

  // Skip trailing system messages (hook output, session start)
  let i = messages.length - 1;
  while (i >= 0 && messages[i]?.role === "system") i--;
  const last = messages[i];
  if (!last || last.role !== "user") return null;

  if (typeof last.content === "string") return last.content.trim() || null;
  if (Array.isArray(last.content)) {
    if (last.content.some((b) => b.type === "tool_result")) return null;
    const text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
  }
  return null;
}

/**
 * Drop thinking blocks that a different model left in the history.
 *
 * Thinking-block signatures are model-specific: a block signed by sonnet
 * fails verification on opus, and a non-thinking model rejects them
 * outright. Only called when the tier for this turn differs from the tier
 * that produced the history, or when the target cannot think at all.
 *
 * Safe at that point because tool-loop continuations keep their pinned tier
 * (extractPrompt returns null for them), so a pending tool_use is never
 * separated from its thinking block.
 */
export function stripThinkingHistory(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return 0;

  let removed = 0;
  const kept = [];
  for (const msg of messages) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) {
      kept.push(msg);
      continue;
    }
    const content = msg.content.filter(
      (b) => b?.type !== "thinking" && b?.type !== "redacted_thinking",
    );
    if (content.length === msg.content.length) {
      kept.push(msg);
      continue;
    }
    removed += msg.content.length - content.length;
    // An assistant turn that was nothing but thinking has no valid form
    // without it — drop the whole message.
    if (content.length > 0) kept.push({ ...msg, content });
  }

  if (removed > 0) body.messages = kept;
  return removed;
}

/**
 * Rewrite the request body to use the chosen tier's model and effort.
 * Strips thinking fields when routing to a non-thinking model.
 */
function applyTier(body, tierName) {
  const spec = tierSpec(tierName);
  if (!spec) return;

  body.model = spec.id;

  if (!spec.thinking) {
    delete body.thinking;
    const dropped = stripThinkingHistory(body);
    if (dropped) log(`stripped ${dropped} thinking block(s) for non-thinking tier ${tierName}`);
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }

  if (spec.effort) {
    body.output_config = { ...(body.output_config ?? {}), effort: spec.effort };
  } else if (body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
}

/**
 * Fix draft-04 JSON Schema relics that Claude Code leaves in MCP tool schemas.
 * The API rejects boolean exclusiveMinimum/Maximum behind a custom base URL.
 */
function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * Start the local proxy. Returns { port, close }.
 */
export async function startProxy() {
  // Per-conversation state: tier pinned for the current turn
  const convos = new Map();

  const server = http.createServer((req, res) => {
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      const isMessagesEndpoint = /^\/v1\/messages/.test(req.url ?? "");

      try {
        const body = JSON.parse(out.toString());

        if (isMessagesEndpoint) {
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));
        }

        if (isAuto(body.model)) {
          if (isMessagesEndpoint) {
            const prompt = extractPrompt(body);
            const firstMsg = body.messages?.[0]?.content;
            const key = typeof firstMsg === "string" ? firstMsg.slice(0, 80) : "default";

            let state = convos.get(key);
            if (!state) {
              if (convos.size > 50) convos.delete(convos.keys().next().value);
              state = { tier: "haiku", lastApplied: null };
              convos.set(key, state);
            }

            if (prompt) {
              const previous = state.tier;
              const jev = await askJev(prompt);
              const { tier, reason } = decide({ jev, current: state.tier });
              state.tier = tier;
              log(
                `${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
                  `-> ${tier} (${reason}) | ${prompt.slice(0, 80)}`,
              );
              const spec = tierSpec(state.tier);
              const conf = jev?.confidence ?? null;
              if (previous !== tier) {
                await animateSwitch(previous, tier, spec, conf);
              } else {
                printStatic(tier, spec, conf);
              }
            }

            // A tier change invalidates any thinking block already in the
            // history — it was signed by the previous model. applyTier only
            // scrubs when the target cannot think, so handle thinking →
            // thinking switches (sonnet → opus) here.
            if (state.lastApplied && state.lastApplied !== state.tier) {
              const dropped = stripThinkingHistory(body);
              if (dropped) {
                log(`stripped ${dropped} thinking block(s) on ${state.lastApplied} -> ${state.tier}`);
              }
            }

            applyTier(body, state.tier);
            state.lastApplied = state.tier;
          } else {
            // Non-messages endpoint (token counting, etc.) — just swap the sentinel
            // to a real model so the API doesn't reject it.
            const fallbackSpec = tierSpec("haiku");
            body.model = fallbackSpec?.id ?? "claude-haiku-4-5-20251001";
            log(`sentinel rewrite on ${req.url}: ${body.model}`);
          }
        }

        out = Buffer.from(JSON.stringify(body));
      } catch (err) {
        // If JSON parsing or routing failed, still scrub the sentinel from the raw
        // buffer so the API never sees "jev-auto".
        const raw = out.toString();
        if (raw.includes(AUTO_MODEL)) {
          const fallbackId = tierSpec("haiku")?.id ?? "claude-haiku-4-5-20251001";
          out = Buffer.from(raw.replaceAll(AUTO_MODEL, fallbackId));
          log(`fallback sentinel scrub on error: ${err.message}`);
        } else {
          log(`body processing error, passing through: ${err.message}`);
        }
      }

      // Track what we routed to, for the ledger
      let routedModel = null;
      let routedTier = null;
      try {
        const peek = JSON.parse(out.toString());
        routedModel = peek.model;
        // Find which tier this model belongs to
        for (const t of TIER_NAMES) {
          if (tierSpec(t)?.id === routedModel) { routedTier = t; break; }
        }
        log(`tracking: model=${routedModel} tier=${routedTier}`);
      } catch (e) {
        log(`tracking: peek failed: ${e.message}`);
      }

      // Forward to Anthropic, intercepting the response to extract usage.
      // Strip accept-encoding so the upstream returns uncompressed SSE that
      // the token-capture parser can read. The client still gets the raw bytes
      // (uncompressed), which Claude Code handles fine.
      const fwdHeaders = { ...req.headers, host: UPSTREAM, "content-length": out.length };
      delete fwdHeaders["accept-encoding"];
      const upstream = https.request(
        {
          hostname: UPSTREAM,
          port: 443,
          path: req.url,
          method: req.method,
          headers: fwdHeaders,
        },
        (upRes) => {
          // Capture subscription usage caps from every response
          captureFromHeaders(upRes.headers);
          log(`upstream: status=${upRes.statusCode} encoding=${upRes.headers["content-encoding"] ?? "none"} routedModel=${routedModel}`);
          res.writeHead(upRes.statusCode, upRes.headers);

          if (!routedModel || upRes.statusCode !== 200) {
            log(`skipping token capture: routedModel=${routedModel} status=${upRes.statusCode}`);
            upRes.pipe(res);
            return;
          }

          // Intercept SSE chunks to find usage in message_delta / message_stop
          let sseBuffer = "";
          let inputTokens = 0;
          let outputTokens = 0;
          let chunkCount = 0;
          let dataLineCount = 0;

          upRes.on("data", (chunk) => {
            res.write(chunk);
            chunkCount++;

            // Parse SSE events from the stream to find usage data
            sseBuffer += chunk.toString();
            const lines = sseBuffer.split("\n");
            // Keep the last incomplete line in the buffer
            sseBuffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              dataLineCount++;
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const evt = JSON.parse(data);
                // Usage appears in message_start (input) and message_delta (output)
                if (evt.type === "message_start" && evt.message?.usage) {
                  inputTokens = evt.message.usage.input_tokens ?? 0;
                  log(`captured input_tokens=${inputTokens}`);
                }
                if (evt.type === "message_delta" && evt.usage) {
                  outputTokens = evt.usage.output_tokens ?? 0;
                  log(`captured output_tokens=${outputTokens}`);
                }
                // Non-streaming: usage at top level
                if (evt.usage && evt.type === "message") {
                  inputTokens = evt.usage.input_tokens ?? 0;
                  outputTokens = evt.usage.output_tokens ?? 0;
                  log(`captured non-stream: in=${inputTokens} out=${outputTokens}`);
                }
              } catch { /* not JSON — SSE comment or partial */ }
            }
          });

          upRes.on("end", () => {
            res.end();
            log(`stream ended: ${chunkCount} chunks, ${dataLineCount} data lines, in=${inputTokens} out=${outputTokens}`);
            if (inputTokens > 0 || outputTokens > 0) {
              const actual = cost(routedModel, inputTokens, outputTokens);
              const baseline = baselineCost(inputTokens, outputTokens);
              record({
                model: routedModel,
                tier: routedTier,
                inputTokens,
                outputTokens,
                cost: actual,
                baselineCost: baseline,
              });
              log(
                `recorded: ${inputTokens} in / ${outputTokens} out | ` +
                  `$${actual.toFixed(4)} actual vs $${baseline.toFixed(4)} opus`,
              );
            } else {
              log(`no tokens captured — nothing to record`);
            }
          });
        },
      );
      upstream.on("error", (err) => {
        log(`upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502).end("Bad Gateway");
      });
      upstream.end(out);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      log(`proxy listening on 127.0.0.1:${port}`);
      resolve({
        port,
        close: () => server.close(),
      });
    });
  });
}
