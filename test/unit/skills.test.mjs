import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { scanSkills, listSkills, adoptSlashCommands, resetSkills } = await import("../../src/skills.mjs");

afterEach(() => resetSkills());

/** Build a throwaway project with .claude/skills and .claude/commands. */
function project(spec) {
  const root = mkdtempSync(join(tmpdir(), "claude-jev-skills-"));
  for (const [rel, body] of Object.entries(spec)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test("reads name and description from skill frontmatter", () => {
  const root = project({
    ".claude/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Ship the thing\n---\n\nbody",
  });
  try {
    const found = scanSkills(root).find((s) => s.name === "deploy");
    assert.ok(found, "skill not discovered");
    assert.equal(found.description, "Ship the thing");
    assert.equal(found.source, "project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regression: folded and literal block scalars are not read as '>'", () => {
  // A naive line parser takes the marker as the value, so the description
  // renders as a bare ">" in the menu.
  const root = project({
    ".claude/skills/folded/SKILL.md":
      "---\nname: folded\ndescription: >\n  first line\n  second line\n---\n",
    ".claude/skills/literal/SKILL.md":
      "---\nname: literal\ndescription: |\n  alpha\n  beta\n---\n",
  });
  try {
    const all = scanSkills(root);
    const folded = all.find((s) => s.name === "folded");
    const literal = all.find((s) => s.name === "literal");
    assert.equal(folded.description, "first line second line", "folded joins with spaces");
    assert.equal(literal.description, "alpha\nbeta", "literal keeps newlines");
    assert.equal(all.filter((s) => /^[>|][-+]?$/.test(s.description.trim())).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command .md files are picked up, named by frontmatter or filename", () => {
  const root = project({
    ".claude/commands/named.md": "---\nname: renamed\ndescription: Has a name\n---\n",
    ".claude/commands/bare.md": "no frontmatter here",
  });
  try {
    const names = scanSkills(root).map((s) => s.name);
    assert.ok(names.includes("renamed"), "frontmatter name wins");
    assert.ok(names.includes("bare"), "falls back to the filename");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory without SKILL.md is not a skill", () => {
  const root = project({ ".claude/skills/empty/notes.md": "nothing to see" });
  try {
    assert.equal(scanSkills(root).find((s) => s.name === "empty"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing directories are not an error", () => {
  assert.ok(Array.isArray(scanSkills(join(tmpdir(), "definitely-not-here-" + Date.now()))));
});

test("Claude Code's slash_commands list overrides the scan", () => {
  const root = project({
    ".claude/skills/kept/SKILL.md": "---\nname: kept\ndescription: Survives\n---\n",
    ".claude/skills/gone/SKILL.md": "---\nname: gone\ndescription: Dropped\n---\n",
  });
  try {
    assert.ok(listSkills(root).some((s) => s.name === "gone"), "present before adoption");

    adoptSlashCommands(["kept", "plugin:extra"]);
    const after = listSkills(root).map((s) => s.name);

    assert.ok(after.includes("kept"), "authoritative name retained");
    assert.ok(after.includes("plugin:extra"), "names we never scanned are added");
    assert.ok(!after.includes("gone"), "names Claude Code does not list are dropped");

    const kept = listSkills(root).find((s) => s.name === "kept");
    assert.equal(kept.description, "Survives", "descriptions survive adoption");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty or malformed slash_commands list is ignored", () => {
  const root = project({ ".claude/skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\n" });
  try {
    const before = listSkills(root).length;
    adoptSlashCommands([]);
    adoptSlashCommands(null);
    adoptSlashCommands("nope");
    assert.equal(listSkills(root).length, before, "the scan must not be wiped out");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("results are sorted and unique", () => {
  const list = scanSkills(process.cwd());
  const names = list.map((s) => s.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "sorted by name");
  assert.equal(new Set(names).size, names.length, "no duplicates");
});
