import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { decide, slashFloor, higherTier } from "../../src/router.mjs";
import { slashCommandOf } from "../../src/config.mjs";

beforeEach(() => {
  delete process.env.CLAUDE_JEV_FLOOR_SLASH;
});

const jev = (choice, confidence = 0.9) => ({ choice, confidence, ms: 1 });

test("a floor raises a tier and never lowers one", () => {
  assert.equal(decide({ jev: jev("haiku"), current: "haiku", floor: "opus" }).tier, "opus");
  // Jev asked for more than the floor: the floor must not pull it back down.
  assert.equal(decide({ jev: jev("opus"), current: "haiku", floor: "sonnet" }).tier, "opus");
  assert.equal(decide({ jev: jev("sonnet"), current: "haiku", floor: null }).tier, "sonnet");
});

test("regression: the floor still applies when Jev is unavailable", () => {
  // Fail-open keeps the current tier, which is the cheapest by default. A
  // floor is a deliberate instruction rather than a guess, so it should not be
  // what disappears the moment something upstream is degraded.
  const out = decide({ jev: null, current: "haiku", floor: "opus" });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /jev-unavailable\+floor/);
});

test("the floor also outranks the low-confidence ceiling", () => {
  const out = decide({ jev: jev("opus", 0.1), current: "haiku", floor: "opus" });
  assert.equal(out.tier, "opus");
});

test("a leading slash command is recognised, a path is not", () => {
  assert.equal(slashCommandOf("/init set up this repo"), "init");
  assert.equal(slashCommandOf("  /code-review the diff"), "code-review");
  assert.equal(slashCommandOf("/plugin:some-skill do a thing"), "plugin:some-skill");
  assert.equal(slashCommandOf("/run"), "run");
  // A prompt opening with a path must not read as a command.
  assert.equal(slashCommandOf("/etc/hosts is mounted where?"), null);
  assert.equal(slashCommandOf("what does 20/20 mean"), null);
  assert.equal(slashCommandOf(""), null);
  assert.equal(slashCommandOf(null), null);
});

test("slashFloor is sonnet by default, configurable, and disablable", () => {
  assert.equal(slashFloor("/code-review the diff"), "sonnet");
  assert.equal(slashFloor("rename a variable"), null);

  process.env.CLAUDE_JEV_FLOOR_SLASH = "opus";
  assert.equal(slashFloor("/run the app"), "opus");

  // Anything that is not a tier name disables it rather than throwing.
  process.env.CLAUDE_JEV_FLOOR_SLASH = "off";
  assert.equal(slashFloor("/run the app"), null);
});

test("higherTier picks the larger, tolerating nulls", () => {
  assert.equal(higherTier("haiku", "opus"), "opus");
  assert.equal(higherTier("opus", "sonnet"), "opus");
  assert.equal(higherTier(null, "sonnet"), "sonnet");
  assert.equal(higherTier("sonnet", null), "sonnet");
  assert.equal(higherTier(null, null), null);
});
