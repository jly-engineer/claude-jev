import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/**
 * The current routing decision, on disk for the status line to read.
 *
 * The proxy used to announce tier switches on stderr, with cursor-control
 * sequences, into the same terminal Claude Code repaints — which scrambled
 * the display — and awaited a ~600ms animation before forwarding the request.
 * Both are gone. The decision is written here instead and rendered by Claude
 * Code's own status line, which owns that row and never fights for it.
 */
export const STATE_PATH = process.env.CLAUDE_JEV_STATE_PATH
  || join(homedir(), ".claude-jev", "current.json");

/**
 * Record the tier in force. Never throws and never blocks the request: a
 * status line that misses an update is preferable to a stalled prompt.
 */
export function writeState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    // Temp + rename, so the status line never reads a half-written file.
    const tmp = `${STATE_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...state, ts: Date.now() }));
    renameSync(tmp, STATE_PATH);
  } catch { /* cosmetic only */ }
}

/** Read the last decision, or null when there is none yet. */
export function readState() {
  try {
    if (!existsSync(STATE_PATH)) return null;
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}
