import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "claude-jev.mjs");

// A stand-in `claude` that reports the --settings file it was handed.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
const i = process.argv.indexOf("--settings");
const path = i >= 0 ? process.argv[i + 1] : null;
const settings = path && fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : null;
process.stdout.write(JSON.stringify({ path, settings }));
`;

function runLauncher() {
  const home = mkdtempSync(join(tmpdir(), "claude-jev-launch-"));
  const bin = join(home, "bin");
  const tmp = join(home, "tmp");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);

  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: tmp,
    PATH: `${bin}:${process.env.PATH}`,
    JEV_API_KEY: "test-key-not-used",
  };
  const child = spawn(process.execPath, [BIN], { env, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, report: JSON.parse(out), home })));
}

test("regression: each launch gets its own settings file, removed on exit", { skip: process.platform === "win32" }, async () => {
  // A shared settings path carried one session's proxy port into another
  // session's chat agent.
  const [a, b] = await Promise.all([runLauncher(), runLauncher()]);
  try {
    for (const run of [a, b]) {
      assert.equal(run.code, 0);
      assert.match(run.report.path, /settings-\d+\.json$/);
      assert.match(run.report.settings.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.ok(!existsSync(run.report.path), "removed when the launcher exits");
    }
    assert.notEqual(a.report.settings.env.ANTHROPIC_BASE_URL, b.report.settings.env.ANTHROPIC_BASE_URL,
      "concurrent sessions keep their own proxy");
  } finally {
    rmSync(a.home, { recursive: true, force: true });
    rmSync(b.home, { recursive: true, force: true });
  }
});
