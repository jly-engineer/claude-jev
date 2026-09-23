import { writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Images pasted into the chat.
 *
 * The agent backend is a `claude -p` child that takes a text prompt, so an
 * image has to reach it as a file it can Read. Pastes are written here and the
 * path is put in the prompt; the directory is added to the agent's --add-dir
 * so the Read is allowed.
 *
 * The type is decided by sniffing magic bytes, never by what the browser
 * claimed and never by a supplied filename — the name is random and the
 * extension is derived. Nothing the caller sends reaches the path.
 */

export const UPLOAD_DIR = process.env.CLAUDE_JEV_UPLOAD_DIR || join(homedir(), ".claude-jev", "uploads");

/** Anthropic accepts these image types. */
const SIGNATURES = [
  { ext: "png",  mime: "image/png",  match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "jpg",  mime: "image/jpeg", match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif",  mime: "image/gif",  match: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { ext: "webp", mime: "image/webp", match: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
];

export const MAX_BYTES = 10 * 1024 * 1024;
const KEEP_MS = 24 * 60 * 60 * 1000;

/** Identify an image by its own bytes. Returns null for anything else. */
export function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  return SIGNATURES.find((s) => s.match(buf)) ?? null;
}

/**
 * Persist one pasted image.
 *
 * @param {Buffer} buf raw image bytes
 * @returns {{ path: string, name: string, mime: string, bytes: number }}
 * @throws when the bytes are not an image, or are too large
 */
export function saveImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error("empty upload");
  if (buf.length > MAX_BYTES) throw new Error(`image is larger than ${Math.round(MAX_BYTES / 1024 / 1024)}MB`);

  const kind = sniff(buf);
  if (!kind) throw new Error("not a PNG, JPEG, GIF or WebP image");

  mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.${kind.ext}`;
  const path = join(UPLOAD_DIR, name);
  writeFileSync(path, buf);
  return { path, name, mime: kind.mime, bytes: buf.length };
}

/**
 * Delete uploads older than a day. Pastes are scratch data — keeping them
 * forever would quietly accumulate screenshots in the home directory.
 */
export function pruneUploads(maxAgeMs = KEEP_MS) {
  if (!existsSync(UPLOAD_DIR)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of readdirSync(UPLOAD_DIR)) {
    const path = join(UPLOAD_DIR, name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true });
        removed++;
      }
    } catch { /* raced with something else; skip */ }
  }
  return removed;
}
