import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDenial } from "../../src/agent.mjs";

// Real strings captured from Claude Code. Each has a different remedy, and
// each one of these was missed in turn — the agent then insisted it was
// waiting for a permission the browser cannot grant, with no explanation.

test("a denylisted tool reports as disabled", () => {
  assert.deepEqual(
    detectDenial("Error: No such tool available: Write. Write is disabled for this session, in subagents as well as here."),
    { reason: "disabled", name: "Write" },
  );
  assert.deepEqual(
    detectDenial("Bash is disabled for this session, in subagents as well as here."),
    { reason: "disabled", name: "Bash" },
  );
});

test("a write outside the working directory reports the path", () => {
  assert.deepEqual(
    detectDenial("Claude requested permissions to write to C:\\Users\\me\\vault\\note.md, but you haven't granted it yet."),
    { reason: "path", path: "C:\\Users\\me\\vault\\note.md" },
  );
});

test("regression: an ungranted tool is not the same as a blocked path", () => {
  // "to use WebSearch" has no second "to", so the path pattern misses it
  // entirely and nothing was reported at all.
  assert.deepEqual(
    detectDenial("Claude requested permissions to use WebSearch, but you haven't granted it yet."),
    { reason: "ungranted", name: "WebSearch" },
  );
  assert.deepEqual(
    detectDenial("Claude requested permissions to use WebFetch, but you haven't granted it yet."),
    { reason: "ungranted", name: "WebFetch" },
  );
});

test("disabled beats the permission wording when both could match", () => {
  const both = "No such tool available: Bash. Bash is disabled for this session. " +
    "Claude requested permissions to use Bash, but you haven't granted it yet.";
  assert.equal(detectDenial(both).reason, "disabled",
    "an outright disable is the more specific and more actionable answer");
});

test("ordinary tool failures are not denials", () => {
  for (const body of [
    "File does not exist.",
    "Error: ENOENT: no such file or directory",
    "String to replace not found in file.",
    "",
  ]) {
    assert.equal(detectDenial(body), null, `false positive on: ${body}`);
  }
});

test("non-string input is handled", () => {
  assert.equal(detectDenial(null), null);
  assert.equal(detectDenial(undefined), null);
  assert.equal(detectDenial({ some: "object" }), null);
  assert.equal(detectDenial(42), null);
});
