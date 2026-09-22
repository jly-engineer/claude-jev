import {
  appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync,
} from "node:fs";
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
 * @param {number} event.inputTokens  - all billed input: uncached + cache write + cache read
 * @param {number} event.outputTokens
 * @param {number} [event.uncachedInputTokens] - the full-rate slice of inputTokens
 * @param {number} [event.cacheWriteTokens]    - cache writes (1.25x / 2x input rate)
 * @param {number} [event.cacheReadTokens]     - cache reads (0.1x input rate)
 * @param {number} event.cost     - actual cost USD
 * @param {number} event.baselineCost - what the baseline model would have cost
 * @param {boolean} [event.estimated] - model had no price entry; costed at baseline rates
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
 *
 * Pure read — it never writes. Pruning used to happen here, which meant the
 * dashboard's 5-second poll rewrote the whole file underneath the proxy's
 * appends and could tear or lose events. Pruning is now `prune()`, called
 * once at startup.
 *
 * @param {number} [days=30]
 * @returns {Array<object>}
 */
export function readEvents(days = RETENTION_DAYS) {
  if (!existsSync(LEDGER_PATH)) return [];

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const events = [];

  for (const line of readFileSync(LEDGER_PATH, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.ts >= cutoff) events.push(ev);
    } catch { /* skip malformed — a torn line from an older build */ }
  }

  return events;
}

/**
 * Drop events older than RETENTION_DAYS from disk.
 *
 * Writes a sibling temp file and renames it over the ledger, so a reader
 * always sees one whole file or the other rather than a half-rewritten one.
 *
 * Call this once at startup, before the proxy begins appending. It is still
 * unsafe to run against a ledger another process is appending to: an append
 * that opened the old file before the rename lands in the replaced inode and
 * is lost. Startup is the one moment this process knows it has no writes of
 * its own in flight.
 *
 * @returns {number} events dropped
 */
export function prune() {
  if (!existsSync(LEDGER_PATH)) return 0;

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const lines = readFileSync(LEDGER_PATH, "utf8").split("\n").filter(Boolean);
  const kept = lines.filter((line) => {
    try {
      return JSON.parse(line).ts >= cutoff;
    } catch {
      return false;
    }
  });

  if (kept.length === lines.length) return 0;

  const tmp = `${LEDGER_PATH}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(LEDGER_PATH), { recursive: true });
    writeFileSync(tmp, kept.join("\n") + (kept.length ? "\n" : ""));
    renameSync(tmp, LEDGER_PATH);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    return 0;
  }

  return lines.length - kept.length;
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
  // "Today" means since local midnight, not the last 24 hours — a rolling
  // window put yesterday evening's spend under today's label. The 7- and
  // 30-day buckets stay rolling, which is what "Last 7 days" says.
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const todayCutoff = midnight.getTime();
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
