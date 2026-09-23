import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "claude-jev-uploads-"));
process.env.CLAUDE_JEV_UPLOAD_DIR = dir;

const { sniff, saveImage, pruneUploads, UPLOAD_DIR, MAX_BYTES } = await import("../../src/uploads.mjs");

afterEach(() => {
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
});

const pad = (head) => Buffer.concat([Buffer.from(head), Buffer.alloc(32)]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = pad([0xff, 0xd8, 0xff, 0xe0]);
const GIF = pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(32),
]);

test("each supported format is recognised by its own bytes", () => {
  assert.equal(sniff(PNG).ext, "png");
  assert.equal(sniff(JPG).ext, "jpg");
  assert.equal(sniff(GIF).ext, "gif");
  assert.equal(sniff(WEBP).ext, "webp");
});

test("the declared type is irrelevant — only the bytes decide", () => {
  // A browser can claim any Content-Type. Trusting it would let an executable
  // or a script land in a directory the agent is granted access to.
  assert.equal(sniff(Buffer.from("<script>alert(1)</script>............")), null);
  assert.equal(sniff(Buffer.from("MZ\x90\x00........................")), null, "a PE header is not an image");
  assert.equal(sniff(Buffer.from("#!/bin/sh\nrm -rf /...............")), null);
  assert.equal(sniff(Buffer.from("%PDF-1.7........................")), null);
});

test("short or absent input is not an image", () => {
  assert.equal(sniff(Buffer.alloc(0)), null);
  assert.equal(sniff(Buffer.from([0x89, 0x50])), null, "too short to identify");
  assert.equal(sniff("not a buffer"), null);
  assert.equal(sniff(null), null);
});

test("saving names the file itself and derives the extension", () => {
  const saved = saveImage(PNG);
  assert.equal(dirname(saved.path), UPLOAD_DIR, "must land in the uploads directory");
  assert.match(saved.name, /^[a-z0-9]+-[0-9a-f]{12}\.png$/, "random name, derived extension");
  assert.equal(saved.mime, "image/png");
  assert.ok(existsSync(saved.path));
});

test("two saves never collide", () => {
  const names = new Set(Array.from({ length: 20 }, () => saveImage(PNG).name));
  assert.equal(names.size, 20);
});

test("non-images and oversized uploads are refused", () => {
  assert.throws(() => saveImage(Buffer.from("just some text, definitely not an image")),
    /not a PNG, JPEG, GIF or WebP/);
  assert.throws(() => saveImage(Buffer.alloc(0)), /empty upload/);
  assert.throws(() => saveImage("not a buffer"), /empty upload/);

  const huge = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES + 1)]);
  assert.throws(() => saveImage(huge), /larger than/);
  assert.equal(readdirSync(dir).length, 0, "nothing is written when validation fails");
});

test("pruning drops old uploads and keeps recent ones", () => {
  const old = saveImage(PNG);
  const fresh = saveImage(JPG);
  const ago = Date.now() / 1000 - 48 * 60 * 60;
  utimesSync(old.path, ago, ago);

  assert.equal(pruneUploads(24 * 60 * 60 * 1000), 1);
  assert.ok(!existsSync(old.path), "the stale one is gone");
  assert.ok(existsSync(fresh.path), "the recent one stays");
});

test("pruning an absent directory is not an error", () => {
  const gone = join(tmpdir(), "claude-jev-not-here-" + Date.now());
  process.env.CLAUDE_JEV_UPLOAD_DIR = gone;
  assert.doesNotThrow(() => pruneUploads());
  process.env.CLAUDE_JEV_UPLOAD_DIR = dir;
});

test("a stray non-image file in the directory does not break pruning", () => {
  writeFileSync(join(dir, "notes.txt"), "left behind");
  assert.doesNotThrow(() => pruneUploads(0));
});
