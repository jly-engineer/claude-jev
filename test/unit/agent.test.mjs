import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { agentConfig, buildArgs } from "../../src/agent.mjs";

const ENV = ["CLAUDE_JEV_AGENT_DENY", "CLAUDE_JEV_AGENT_TOOLS", "CLAUDE_JEV_AGENT_PERMISSION", "CLAUDE_JEV_AGENT_DIRS"];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

const args = (extra = {}) => buildArgs({ prompt: "hi", sessionId: "S", started: false, ...extra });
/** The values passed to a flag, up to the next flag. */
function flagValues(list, flag) {
  const i = list.indexOf(flag);
  if (i === -1) return null;
  const out = [];
  for (let j = i + 1; j < list.length && !list[j].startsWith("--"); j++) out.push(list[j]);
  return out;
}

test("regression: the denylist is the safety boundary, not the allowlist", () => {
  // --allowed-tools grants, it does not confine. With permission-mode
  // acceptEdits, "--allowed-tools Read Glob Grep" still let the agent call
  // Write and create a file. Only --disallowed-tools refuses it outright.
  const deny = flagValues(args(), "--disallowed-tools");
  assert.ok(deny, "--disallowed-tools must always be passed");
  for (const tool of ["Write", "Edit", "NotebookEdit", "Bash"]) {
    assert.ok(deny.includes(tool), `${tool} must be denied by default`);
  }
});

test("the default agent cannot write, execute, or spawn subagents", () => {
  const cfg = agentConfig();
  assert.equal(cfg.writable, false);
  const deny = flagValues(args(), "--disallowed-tools");
  assert.ok(deny.includes("PowerShell"), "PowerShell is a shell too");
  assert.ok(deny.includes("Task"), "subagents could route around the denylist");
  assert.ok(!flagValues(args(), "--allowed-tools").some((t) => deny.includes(t)),
    "the two lists must not contradict each other");
});

test("a writable agent requires setting the denylist empty on purpose", () => {
  process.env.CLAUDE_JEV_AGENT_DENY = "";
  const cfg = agentConfig();
  assert.equal(cfg.writable, true, "explicitly empty means opt in");
  assert.equal(flagValues(args(), "--disallowed-tools"), null, "no flag when nothing is denied");
});

test("an unset denylist falls back to the safe default, it does not open up", () => {
  delete process.env.CLAUDE_JEV_AGENT_DENY;
  assert.ok(agentConfig().deny.includes("Write"), "absent env must not mean permissive");
});

test("the denylist can be narrowed deliberately", () => {
  process.env.CLAUDE_JEV_AGENT_DENY = "Bash";
  const deny = flagValues(args(), "--disallowed-tools");
  assert.deepEqual(deny, ["Bash"]);
  assert.equal(agentConfig().writable, false, "still not fully writable");
});

test("extra writable roots are passed with --add-dir", () => {
  // acceptEdits only auto-approves edits inside the working directory. Outside
  // it, the tool stalls waiting for a permission a browser cannot grant, so
  // any other root has to be declared up front.
  process.env.CLAUDE_JEV_AGENT_DIRS = "C:/vault/Knowledge Base;C:/tmp/other";
  assert.deepEqual(agentConfig().dirs, ["C:/vault/Knowledge Base", "C:/tmp/other"]);
  assert.deepEqual(flagValues(args(), "--add-dir"), ["C:/vault/Knowledge Base", "C:/tmp/other"]);
});

test("semicolons separate roots, so paths may contain spaces", () => {
  process.env.CLAUDE_JEV_AGENT_DIRS = "C:/Users/me/OneDrive - Corp/Documents/Knowledge Base";
  assert.deepEqual(agentConfig().dirs, ["C:/Users/me/OneDrive - Corp/Documents/Knowledge Base"],
    "a space-containing path must survive as one entry");
});

test("blank and empty directory entries are dropped", () => {
  process.env.CLAUDE_JEV_AGENT_DIRS = " ;; C:/a ; ";
  assert.deepEqual(agentConfig().dirs, ["C:/a"]);
  delete process.env.CLAUDE_JEV_AGENT_DIRS;
  assert.deepEqual(agentConfig().dirs, [], "unset means no extra roots");
  assert.equal(flagValues(args(), "--add-dir"), null, "no flag when there are none");
});

test("session flags: open on the first turn, resume after", () => {
  assert.ok(args({ started: false }).includes("--session-id"));
  assert.ok(!args({ started: false }).includes("--resume"));
  assert.ok(args({ started: true }).includes("--resume"));
  assert.ok(!args({ started: true }).includes("--session-id"));
});

test("stream-json is requested so the stream can be parsed", () => {
  const a = args();
  assert.deepEqual(flagValues(a, "--output-format"), ["stream-json"]);
  assert.ok(a.includes("--verbose"), "stream-json needs --verbose to emit events");
  assert.equal(a[0], "-p", "headless mode");
});

test("the settings file is passed only when there is one", () => {
  assert.ok(!args().includes("--settings"));
  assert.deepEqual(flagValues(args({ settingsFile: "C:/x/settings.json" }), "--settings"),
    ["C:/x/settings.json"]);
});
