#!/usr/bin/env node
/**
 * Status line for Claude Code: the tier in force, and today's saving.
 *
 * Claude Code runs this per refresh and renders the first line it prints.
 * It owns that row, so nothing here ever fights the main display for the
 * terminal — which is exactly why the proxy no longer prints anything.
 *
 * Reads only local state. stdin carries a session payload we do not need, but
 * it is drained so the writer never sees a broken pipe.
 */
import { readState } from "../src/state.mjs";
import { readEvents, aggregate } from "../src/ledger.mjs";

process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("error", () => {});

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  haiku: "\x1b[32m", sonnet: "\x1b[33m", opus: "\x1b[35m",
};

const money = (n) => "$" + (Math.abs(n) < 0.005 ? "0.00" : n.toFixed(2));

function line() {
  const state = readState();
  const parts = [];

  if (state?.tier) {
    const colour = C[state.tier] ?? "";
    const conf = typeof state.confidence === "number" ? ` ${C.dim}p=${state.confidence.toFixed(2)}${C.reset}` : "";
    const moved = state.previous && state.previous !== state.tier
      ? `${C.dim}${state.previous}→${C.reset}`
      : "";
    parts.push(`⚡ ${moved}${colour}${C.bold}${state.tier}${C.reset}${conf}`);
  } else {
    parts.push(`${C.dim}⚡ jev${C.reset}`);
  }

  try {
    const { today } = aggregate(readEvents(1));
    if (today.requests > 0) {
      const saved = today.baselineCost - today.cost;
      const pct = today.baselineCost > 0 ? (saved / today.baselineCost) * 100 : 0;
      parts.push(`${C.dim}${money(saved)} saved today · ${pct.toFixed(0)}%${C.reset}`);
    }
  } catch { /* a status line must never be the thing that breaks */ }

  return parts.join(`  ${C.dim}·${C.reset}  `);
}

try {
  process.stdout.write(line() + "\n");
} catch {
  process.stdout.write("⚡ jev\n");
}
