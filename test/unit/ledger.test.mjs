import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// LEDGER_PATH is resolved when the module loads, so point it at a temp file
// before importing.
const dir = mkdtempSync(join(tmpdir(), "claude-jev-test-"));
const LEDGER = join(dir, "usage.jsonl");
process.env.CLAUDE_JEV_LEDGER_PATH = LEDGER;

const { readEvents, prune, aggregate, record, reset } = await import("../../src/ledger.mjs");

const DAY = 86_400_000;
const now = Date.now();
const ev = (ts, cost = 1) =>
  JSON.stringify({ ts, tier: "haiku", inputTokens: 100, outputTokens: 10, cost, baselineCost: cost * 3 });
const seed = (...lines) => writeFileSync(LEDGER, lines.join("\n") + "\n");

beforeEach(() => reset());
after(() => rmSync(dir, { recursive: true, force: true }));

test("readEvents filters to the lookback window", () => {
  seed(ev(now - 40 * DAY), ev(now - 2 * DAY), ev(now - 1000));
  assert.equal(readEvents(30).length, 2);
  assert.equal(readEvents(1).length, 1);
});

test("regression: reading never writes", () => {
  // Pruning used to happen inside readEvents, so the dashboard's 5s poll
  // rewrote the file underneath the proxy's appends.
  seed(ev(now - 40 * DAY), ev(now - 1000));
  const before = readFileSync(LEDGER, "utf8");
  readEvents(30);
  readEvents(7);
  readEvents(1);
  assert.equal(readFileSync(LEDGER, "utf8"), before, "the expired event must still be on disk");
});

test("a torn line is skipped without losing its neighbours", () => {
  seed(ev(now - 1000), '{"ts":123,"broke', ev(now - 2000));
  assert.equal(readEvents(30).length, 2);
});

test("prune drops expired events and is idempotent", () => {
  seed(ev(now - 40 * DAY), ev(now - 31 * DAY), ev(now - 2 * DAY), ev(now - 1000));
  assert.equal(prune(), 2);
  assert.equal(readEvents(30).length, 2);
  assert.ok(readFileSync(LEDGER, "utf8").endsWith("\n"), "stays newline-terminated");
  assert.equal(prune(), 0, "second prune is a no-op");
});

test("prune leaves no temp file behind", () => {
  seed(ev(now - 40 * DAY), ev(now - 1000));
  prune();
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".tmp")), []);
});

test("prune handles an empty ledger", () => {
  writeFileSync(LEDGER, "");
  assert.equal(prune(), 0);
  assert.equal(readEvents(30).length, 0);
});

test("appended events survive a prune", () => {
  record({ model: "claude-haiku-4-5", tier: "haiku", inputTokens: 5, outputTokens: 5, cost: 0.1, baselineCost: 0.3 });
  record({ model: "claude-haiku-4-5", tier: "haiku", inputTokens: 5, outputTokens: 5, cost: 0.1, baselineCost: 0.3 });
  prune();
  assert.equal(readEvents(30).length, 2);
});

test("regression: Today is since local midnight, not a rolling 24 hours", () => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  seed(
    ev(midnight.getTime() - 3_600_000, 5),  // an hour before midnight: yesterday
    ev(midnight.getTime() + 60_000, 7),     // just after midnight: today
    ev(now - 1000, 11),                     // now: today
  );
  const a = aggregate(readEvents(30));
  assert.equal(a.today.requests, 2, "yesterday evening must not count as today");
  assert.equal(a.today.cost, 18);
  assert.equal(a.week.requests, 3, "the week bucket stays a rolling window");
  assert.equal(a.month.requests, 3);
});

test("aggregate totals by tier", () => {
  seed(
    JSON.stringify({ ts: now - 1000, tier: "haiku", inputTokens: 10, outputTokens: 2, cost: 1, baselineCost: 4 }),
    JSON.stringify({ ts: now - 2000, tier: "opus", inputTokens: 20, outputTokens: 4, cost: 3, baselineCost: 3 }),
  );
  const a = aggregate(readEvents(30));
  assert.equal(a.byTier.haiku.requests, 1);
  assert.equal(a.byTier.opus.requests, 1);
  assert.equal(a.month.cost, 4);
  assert.equal(a.month.baselineCost, 7);
});
