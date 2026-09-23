#!/usr/bin/env node
/**
 * Routing accuracy check: run every case through the real Jev classifier and
 * compare the tier it picks against the hand label in cases.mjs.
 *
 * THIS COSTS MONEY. One Jev call per case, against the live API. It is not
 * part of `npm test` for that reason — run it deliberately, when you have
 * changed the tier guidance in src/config.mjs or the policy in decide().
 *
 *   node test/routing/run.mjs
 *   node test/routing/run.mjs --only T08,T09,T15     one or more cases
 *   node test/routing/run.mjs --json                 machine-readable
 *
 * Exits non-zero below THRESHOLD accuracy, so CI can gate on it.
 *
 * What this measures: whether Jev, reading the guidance in config.mjs,
 * reaches the same tier a human did. It does not measure whether the human
 * labels are right. Cases the guidance was written from will pass almost by
 * construction — treat a jump in accuracy right after editing the guidance as
 * confirmation the edit landed, not as evidence it generalizes.
 */

import { loadEnvFile } from "../../src/env.mjs";
import { askJev, decide } from "../../src/router.mjs";
import { CASES, CATEGORIES } from "./cases.mjs";

// Pick up ~/.claude-jev.env the same way the launcher does, so the key does
// not have to be exported by hand (and so a UTF-16 file still works).
loadEnvFile();

const THRESHOLD = 85;

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const onlyFlag = argv.indexOf("--only");
const only = onlyFlag >= 0
  ? new Set((argv[onlyFlag + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean))
  : null;

const cases = only ? CASES.filter((c) => only.has(c.id)) : CASES;

if (cases.length === 0) {
  process.stderr.write(`No cases matched --only ${[...(only ?? [])].join(",")}\n`);
  process.exit(2);
}

if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) {
  process.stderr.write(
    "No JEV_API_KEY / TYPESAFE_API_KEY set. This check needs the live Jev API.\n",
  );
  process.exit(2);
}

// ── Colors ──────────────────────────────────────────────────────────────────
const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m" };
const tint = (s, c) => (process.stdout.isTTY ? c + s + C.reset : s);
const pad = (s, n) => String(s ?? "-").padEnd(n);

/** Classify one prompt the way the proxy does: askJev, then the decide() policy. */
async function route(prompt) {
  const jev = await askJev(prompt);
  if (!jev) return { tier: null, confidence: null, reason: "jev-unavailable", ms: null };
  const { tier, reason } = decide({ jev, current: "haiku" });
  return { tier, confidence: jev.confidence, reason, ms: jev.ms };
}

const results = [];

if (!json) {
  process.stdout.write(`\n${C.bold}claude-jev routing accuracy${C.reset}  ${C.dim}${cases.length} cases, live Jev${C.reset}\n\n`);
  process.stdout.write(
    C.dim + pad("ID", 6) + pad("Category", 10) + pad("Name", 24) + pad("Got", 8) +
    pad("Want", 8) + pad("Conf", 7) + pad("ms", 7) + "Reason" + C.reset + "\n",
  );
  process.stdout.write(C.dim + "-".repeat(86) + C.reset + "\n");
}

for (const c of cases) {
  const r = await route(c.prompt);
  const ok = r.tier === c.expected;
  results.push({ ...c, ...r, ok });

  if (!json) {
    const mark = ok ? tint("ok  ", C.green) : tint("MISS", C.red);
    process.stdout.write(
      pad(c.id, 6) + pad(c.category, 10) + pad(c.name.slice(0, 22), 24) +
      pad(r.tier, 8) + pad(c.expected, 8) +
      pad(r.confidence == null ? "-" : r.confidence.toFixed(2), 7) +
      pad(r.ms ?? "-", 7) + pad(r.reason, 26) + mark + "\n",
    );
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
const hits = results.filter((r) => r.ok).length;
const accuracy = (hits / results.length) * 100;
const latencies = results.map((r) => r.ms).filter((n) => typeof n === "number").sort((a, b) => a - b);
const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] : null);
const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

const byCategory = Object.fromEntries(
  CATEGORIES.map((cat) => {
    const rows = results.filter((r) => r.category === cat);
    return [cat, { total: rows.length, hits: rows.filter((r) => r.ok).length }];
  }).filter(([, v]) => v.total > 0),
);

const misses = results.filter((r) => !r.ok);

if (json) {
  process.stdout.write(JSON.stringify({
    accuracy, hits, total: results.length, threshold: THRESHOLD,
    latencyMs: { avg, p50: pct(0.5), p95: pct(0.95), max: latencies.at(-1) ?? null },
    byCategory,
    results: results.map(({ id, category, expected, tier, confidence, reason, ms, ok }) =>
      ({ id, category, expected, got: tier, confidence, reason, ms, ok })),
  }, null, 2) + "\n");
} else {
  process.stdout.write(C.dim + "-".repeat(86) + C.reset + "\n\n");
  const headline = `${hits}/${results.length} (${accuracy.toFixed(1)}%)`;
  process.stdout.write(`  ${C.bold}Accuracy${C.reset}  ${tint(headline, accuracy >= THRESHOLD ? C.green : C.red)}\n`);
  for (const [cat, v] of Object.entries(byCategory)) {
    process.stdout.write(`  ${C.dim}${pad(cat, 10)}${C.reset} ${v.hits}/${v.total}\n`);
  }
  if (latencies.length) {
    process.stdout.write(`\n  ${C.bold}Jev latency${C.reset}  avg ${avg}ms · p50 ${pct(0.5)}ms · p95 ${pct(0.95)}ms · max ${latencies.at(-1)}ms\n`);
  }
  if (misses.length) {
    process.stdout.write(`\n  ${C.bold}Misses${C.reset}\n`);
    for (const m of misses) {
      const conf = m.confidence == null ? "n/a" : m.confidence.toFixed(2);
      process.stdout.write(`    ${m.id}  got ${m.tier ?? "none"}, want ${m.expected}  ${C.dim}conf ${conf} · ${m.reason}${C.reset}\n`);
      process.stdout.write(`    ${C.dim}${m.prompt.slice(0, 96)}${m.prompt.length > 96 ? "..." : ""}${C.reset}\n`);
    }
    // A confident miss is a guidance problem; an unconfident one may be policy.
    const confident = misses.filter((m) => (m.confidence ?? 0) >= 0.8);
    if (confident.length) {
      process.stdout.write(
        `\n  ${C.dim}${confident.length} miss(es) at confidence >= 0.80 — Jev was sure and wrong, so no\n` +
        `  confidence threshold can catch these. Fix the tier guidance in src/config.mjs.${C.reset}\n`,
      );
    }
  }
  process.stdout.write("\n");
}

// Set the code rather than calling process.exit(): the Jev SDK still has
// handles open at this point, and tearing them down mid-flight trips a libuv
// assertion on Windows. unref the loop instead so we exit once it drains.
process.exitCode = accuracy >= THRESHOLD ? 0 : 1;
