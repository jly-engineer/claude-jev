import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const LEDGER_DIR = join(homedir(), ".claude-jev");
const LEDGER_PATH = process.env.CLAUDE_JEV_LEDGER_PATH ?? join(LEDGER_DIR, "usage.jsonl");
const RETENTION_DAYS = 30;

/**
 * Append one usage event to the ledger.
 *
 * @param {object} event
 * @param {string} event.model    - actual model id used
 * @param {string} event.tier     - tier name (haiku/sonnet/opus)
 * @param {number} event.inputTokens
 * @param {number} event.outputTokens
 * @param {number} event.cost     - actual cost USD
 * @param {number} event.baselineCost - what opus 4.6 would have cost
 * @param {string} [event.reason] - routing reason
 */
export function record(event) {
  try {
    mkdirSync(dirname(LEDGER_PATH), { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), ...event }) + "\n";
    appendFileSync(LEDGER_PATH, line, { flag: "a" });
  } catch (err) {
    // Never block the proxy on a ledger write failure.
    if (process.env.JEV_DEBUG) {
      process.stderr.write(`[claude-jev] ledger write error: ${err.message}\n`);
    }
  }
}

/**
 * Read all events within a lookback window.
 * Self-prunes events older than RETENTION_DAYS.
 *
 * @param {number} [days=30]
 * @returns {Array<object>}
 */
export function readEvents(days = RETENTION_DAYS) {
  if (!existsSync(LEDGER_PATH)) return [];

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const lines = readFileSync(LEDGER_PATH, "utf8").split("\n").filter(Boolean);
  const events = [];
  const kept = [];

  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.ts >= cutoff) {
        events.push(ev);
        kept.push(line);
      }
    } catch { /* skip malformed */ }
  }

  // Compact: drop old events from disk
  if (kept.length < lines.length) {
    try {
      writeFileSync(LEDGER_PATH, kept.join("\n") + (kept.length ? "\n" : ""));
    } catch { /* non-fatal */ }
  }

  return events;
}

/**
 * Aggregate events into time-window summaries.
 *
 * @param {Array<object>} events
 * @returns {{ today: object, week: object, month: object, byTier: object }}
 */
export function aggregate(events) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const todayCutoff = now - 1 * dayMs;
  const weekCutoff = now - 7 * dayMs;

  const buckets = {
    today: { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, baselineCost: 0 },
    week:  { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, baselineCost: 0 },
    month: { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, baselineCost: 0 },
  };
  const byTier = {};

  for (const ev of events) {
    const add = (b) => {
      b.requests++;
      b.inputTokens += ev.inputTokens ?? 0;
      b.outputTokens += ev.outputTokens ?? 0;
      b.cost += ev.cost ?? 0;
      b.baselineCost += ev.baselineCost ?? 0;
    };

    // All events are within 30 days (already filtered)
    add(buckets.month);
    if (ev.ts >= weekCutoff) add(buckets.week);
    if (ev.ts >= todayCutoff) add(buckets.today);

    const tier = ev.tier ?? "unknown";
    byTier[tier] ??= { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, baselineCost: 0 };
    add(byTier[tier]);
  }

  return { ...buckets, byTier };
}

/** Reset the ledger. */
export function reset() {
  try {
    writeFileSync(LEDGER_PATH, "");
  } catch { /* non-fatal */ }
}

export { LEDGER_PATH };
