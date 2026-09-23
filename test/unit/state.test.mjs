import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "claude-jev-state-"));
process.env.CLAUDE_JEV_STATE_PATH = join(dir, "current.json");

const { writeState, readState, STATE_PATH } = await import("../../src/state.mjs");

afterEach(() => {
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
});

test("a decision round-trips with a timestamp", () => {
  writeState({ tier: "sonnet", previous: "haiku", model: "claude-sonnet-5", confidence: 0.92, reason: "jev" });
  const s = readState();
  assert.equal(s.tier, "sonnet");
  assert.equal(s.previous, "haiku");
  assert.equal(s.confidence, 0.92);
  assert.ok(s.ts > 0, "stamped so a stale line is detectable");
});

test("no state yet reads as null rather than throwing", () => {
  assert.equal(readState(), null);
});

test("a corrupt state file reads as null", () => {
  // The status line must degrade, never crash the row it owns.
  writeFileSync(STATE_PATH, "{ not json");
  assert.equal(readState(), null);
});

test("writing leaves no temp file behind", () => {
  // Written temp-then-rename so a reader never sees a half-written file.
  writeState({ tier: "opus" });
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".tmp")), []);
  assert.ok(existsSync(STATE_PATH));
});

test("each write replaces the last", () => {
  writeState({ tier: "haiku" });
  writeState({ tier: "opus" });
  assert.equal(readState().tier, "opus");
  assert.equal(readdirSync(dir).length, 1);
});

test("writing never throws, whatever it is handed", () => {
  // Cosmetic state must not be able to take a request down with it.
  assert.doesNotThrow(() => writeState(undefined));
  assert.doesNotThrow(() => writeState({ circular: (() => { const o = {}; o.self = o; return o; })() }));
});
