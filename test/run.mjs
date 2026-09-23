#!/usr/bin/env node
/**
 * Run the offline unit suite.
 *
 * `node --test` needs explicit files here. Given a directory it tries to
 * execute the directory itself; given nothing it walks the tree and picks up
 * test/routing/judge.mjs, which is not a test and wants an API key. A glob
 * works, but only on Node versions whose test runner expands globs, and on
 * Linux the shell would expand it first — so the file list is built here
 * instead and every platform and version behaves the same.
 */
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const unitDir = join(here, "unit");

const files = readdirSync(unitDir)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => join(unitDir, f));

if (files.length === 0) {
  process.stderr.write("No test files found in test/unit\n");
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...files, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("error", (err) => {
  process.stderr.write(`Could not start the test runner: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
