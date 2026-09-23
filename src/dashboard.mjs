import { readEvents, aggregate, LEDGER_PATH } from "./ledger.mjs";
import { BASELINE_MODEL, modelLabel } from "./pricing.mjs";

// ── Colors ──────────────────────────────────────────────────────────────────
const CYAN    = "\x1b[36m";
const GREEN   = "\x1b[32m";
const YELLOW  = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const DIM     = "\x1b[2m";
const BOLD    = "\x1b[1m";
const RST     = "\x1b[0m";
const WHITE   = "\x1b[37m";
const RED     = "\x1b[31m";

const TIER_COLORS = { haiku: GREEN, sonnet: YELLOW, opus: MAGENTA };

// ── Formatting helpers ──────────────────────────────────────────────────────
function dollars(n) {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function tokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function pct(part, whole) {
  if (whole === 0) return "0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function bar(ratio, width = 20) {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return GREEN + "█".repeat(filled) + DIM + "░".repeat(empty) + RST;
}

// ── Dashboard rendering ─────────────────────────────────────────────────────

function renderWindow(label, bucket, labelWidth = 14) {
  const saved = bucket.baselineCost - bucket.cost;
  const savingsRatio = bucket.baselineCost > 0 ? saved / bucket.baselineCost : 0;
  // New work, not re-sent prefix. See aggregate() for why.
  const totalTokens = bucket.newInputTokens + bucket.outputTokens;

  const paddedLabel = label.padEnd(labelWidth);
  const savingsStr = `${BOLD}${pct(saved, bucket.baselineCost)}${RST} saved`;
  const tokenStr = `${tokens(totalTokens)} new`;
  const costStr = `${GREEN}${dollars(saved)} saved${RST}`;

  return (
    `${CYAN}${paddedLabel}${RST} ${bar(savingsRatio)} ` +
    `${savingsStr}  ${DIM}${tokenStr}${RST}  ${costStr}  ${DIM}(${bucket.requests} reqs)${RST}`
  );
}

function renderTierBreakdown(byTier) {
  const tiers = Object.entries(byTier).sort(
    ([, a], [, b]) => b.requests - a.requests,
  );
  if (tiers.length === 0) return `  ${DIM}(no data)${RST}`;

  const lines = [];
  for (const [tier, b] of tiers) {
    const color = TIER_COLORS[tier] ?? WHITE;
    const saved = b.baselineCost - b.cost;
    const totalTokens = b.newInputTokens + b.outputTokens;
    lines.push(
      `  ${color}${BOLD}${tier.padEnd(8)}${RST} ` +
        `${String(b.requests).padStart(4)} reqs  ` +
        `${tokens(totalTokens).padStart(7)} new  ` +
        `${GREEN}${dollars(saved).padStart(8)} saved${RST}  ` +
        `${DIM}(actual: ${dollars(b.cost)})${RST}`,
    );
  }
  return lines.join("\n");
}

/**
 * Render the full savings dashboard to a string.
 */
export function renderDashboard({ days = 30, json = false } = {}) {
  const events = readEvents(days);

  if (json) {
    const agg = aggregate(events);
    return JSON.stringify(agg, null, 2);
  }

  if (events.length === 0) {
    return (
      `\n${CYAN}${BOLD}  claude-jev savings${RST}\n` +
      `${DIM}  ─────────────────────────────────────────────${RST}\n` +
      `  No usage data yet. Start a session with ${BOLD}claude-jev${RST}\n` +
      `  and the dashboard will populate as you work.\n` +
      `\n  ${DIM}Ledger: ${LEDGER_PATH}${RST}\n`
    );
  }

  const { today, week, month, byTier } = aggregate(events);

  const totalSaved = month.baselineCost - month.cost;
  const totalTokens = month.newInputTokens + month.outputTokens;

  const lines = [
    "",
    `${CYAN}${BOLD}  ⚡ claude-jev savings${RST}  ${DIM}vs always using ${modelLabel(BASELINE_MODEL)}${RST}`,
    `${DIM}  ─────────────────────────────────────────────────────────────────${RST}`,
    "",
    `  ${renderWindow("Today", today)}`,
    `  ${renderWindow("Last 7 days", week)}`,
    `  ${renderWindow("Last 30 days", month)}`,
    "",
    `${DIM}  ─────────────────────────────────────────────────────────────────${RST}`,
    `  ${CYAN}${BOLD}Cost breakdown by tier:${RST}`,
    "",
    renderTierBreakdown(byTier),
    "",
    `${DIM}  ─────────────────────────────────────────────────────────────────${RST}`,
    `  ${BOLD}Total:${RST}  ${tokens(totalTokens)} new tokens across ${month.requests} requests`,
    `  ${DIM}         ${tokens(month.cacheReadTokens)} cached (prefix re-reads, billed at a tenth)${RST}`,
    `  ${BOLD}Actual cost:${RST}     ${dollars(month.cost)}`,
    `  ${BOLD}${modelLabel(BASELINE_MODEL)} would be:${RST} ${dollars(month.baselineCost)}`,
    `  ${GREEN}${BOLD}You saved:${RST}       ${GREEN}${BOLD}${dollars(totalSaved)}${RST}  ${DIM}(${pct(totalSaved, month.baselineCost)})${RST}`,
    "",
    `  ${DIM}Ledger: ${LEDGER_PATH}${RST}`,
    "",
  ];

  return lines.join("\n");
}
