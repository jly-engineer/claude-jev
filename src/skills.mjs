import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

/**
 * Slash commands available to the chat agent.
 *
 * Two sources, in increasing order of authority:
 *
 *  1. A filesystem scan. Free and instant, so the typeahead works before any
 *     turn has run, and it is the only place descriptions live.
 *  2. `slash_commands` on Claude Code's `init` stream event. This is the real
 *     list — it already handles plugin namespacing, project vs user
 *     precedence, and anything the scan does not know about. Captured from
 *     turns that happen anyway, so it costs nothing.
 *
 * The scan supplies the prose; the init list decides what actually exists.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function frontmatter(file) {
  try {
    // Skills can be long; the frontmatter is always at the top.
    const head = readFileSync(file, "utf8").slice(0, 4096);
    const m = FRONTMATTER.exec(head);
    if (!m) return {};
    const out = {};
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const colon = line.indexOf(":");
      if (colon < 1 || /^\s/.test(line)) continue;
      const key = line.slice(0, colon).trim();
      let value = line.slice(colon + 1).trim();

      // Folded (>) and literal (|) block scalars: the value is the indented
      // block underneath, not the marker. Without this, a description that
      // uses one reads as a bare ">".
      if (/^[>|][-+]?$/.test(value)) {
        const folded = value.startsWith(">");
        const block = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
        value = block.join(folded ? " " : "\n");
      } else {
        value = value.replace(/^["']|["']$/g, "");
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

const dirs = (p) => {
  try {
    return readdirSync(p).map((n) => join(p, n)).filter((f) => statSync(f).isDirectory());
  } catch {
    return [];
  }
};
const files = (p, ext) => {
  try {
    return readdirSync(p).filter((n) => n.endsWith(ext)).map((n) => join(p, n));
  } catch {
    return [];
  }
};

function addSkillDir(out, dir, prefix, source) {
  for (const skill of dirs(dir)) {
    const md = join(skill, "SKILL.md");
    if (!existsSync(md)) continue;
    const fm = frontmatter(md);
    const name = prefix ? `${prefix}:${fm.name || basename(skill)}` : (fm.name || basename(skill));
    out.set(name, { name, description: fm.description || "", source });
  }
}

function addCommandFiles(out, dir, source) {
  for (const f of files(dir, ".md")) {
    const fm = frontmatter(f);
    const name = fm.name || basename(f, ".md");
    out.set(name, { name, description: fm.description || "", source });
  }
}

/** Walk every place a slash command can come from. */
export function scanSkills(projectDir = process.cwd()) {
  const out = new Map();
  const home = homedir();

  addSkillDir(out, join(home, ".claude", "skills"), null, "user");
  addCommandFiles(out, join(home, ".claude", "commands"), "user");

  addSkillDir(out, join(projectDir, ".claude", "skills"), null, "project");
  addCommandFiles(out, join(projectDir, ".claude", "commands"), "project");

  // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>/
  // A plugin can have several versions cached; later ones overwrite earlier,
  // which is fine because the name is what matters.
  for (const marketplace of dirs(join(home, ".claude", "plugins", "cache"))) {
    for (const plugin of dirs(marketplace)) {
      for (const version of dirs(plugin)) {
        addSkillDir(out, join(version, "skills"), basename(plugin), "plugin");
      }
    }
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

let cache = null;
let authoritative = null;

/** The list for the typeahead. Scanned once, then refined by init events. */
export function listSkills(projectDir) {
  cache ??= scanSkills(projectDir);
  if (!authoritative) return cache;

  const known = new Map(cache.map((s) => [s.name, s]));
  return authoritative
    .map((name) => known.get(name) ?? { name, description: "", source: "claude" })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Adopt the `slash_commands` list from a Claude Code init event.
 * Names only — descriptions stay with whatever the scan found.
 */
export function adoptSlashCommands(names) {
  if (!Array.isArray(names) || names.length === 0) return;
  authoritative = names.filter((n) => typeof n === "string" && n);
}

/** Test seam. */
export function resetSkills() {
  cache = null;
  authoritative = null;
}
