import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENV_FILES = [".claude-jev.env", ".jev-router.env"];

/**
 * Load key=value pairs from the user's env file into process.env.
 *
 * Existing environment variables win, so an explicit export always beats the
 * file. Unreadable files are skipped rather than fatal.
 *
 * Handles UTF-16 LE, because PowerShell's `Set-Content` writes that by
 * default and `echo "JEV_API_KEY=..." > ~/.claude-jev.env` in a PowerShell
 * prompt produces a file no naive parser can read.
 */
export function loadEnvFile() {
  for (const name of ENV_FILES) {
    const path = join(homedir(), name);
    try {
      if (!existsSync(path)) continue;
      let raw = readFileSync(path);
      if (raw[0] === 0xff && raw[1] === 0xfe) {
        raw = Buffer.from(raw.toString("utf16le"));
      }
      const text = raw.toString("utf8").replace(/\0/g, "");
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
    } catch { /* skip unreadable */ }
  }
}
