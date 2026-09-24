import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Saved chats, one JSON file each, so a conversation survives a refresh, a
 * trip to the dashboard, and a restart. Kept until deleted.
 *
 * The id arrives from the browser and becomes a filename, so it is checked
 * against a strict pattern before it touches the filesystem.
 */

export const CHAT_DIR = process.env.CLAUDE_JEV_CHAT_DIR || join(homedir(), ".claude-jev", "chats");

const ID_RE = /^chat-[a-z0-9]{6,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 80;

export const validChatId = (id) => typeof id === "string" && ID_RE.test(id);

const fileFor = (id) => join(CHAT_DIR, `${id}.json`);

export function newChat(id) {
  const now = new Date().toISOString();
  return { id, title: "", created: now, updated: now, messages: [] };
}

/** The saved chat, or null if there is none (or the id is not one of ours). */
export function loadChat(id) {
  if (!validChatId(id)) return null;
  try {
    return JSON.parse(readFileSync(fileFor(id), "utf8"));
  } catch {
    return null;
  }
}

/** Write atomically: a reader never sees half a file. */
export function saveChat(chat) {
  if (!validChatId(chat?.id)) throw new Error("invalid chat id");
  mkdirSync(CHAT_DIR, { recursive: true });
  chat.updated = new Date().toISOString();
  if (!chat.title) chat.title = titleFrom(chat.messages);
  const tmp = `${fileFor(chat.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(chat));
  renameSync(tmp, fileFor(chat.id));
  return chat;
}

function titleFrom(messages) {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "";
  const text = (first.text || "").replace(/\s+/g, " ").trim();
  if (!text) return first.images?.length ? "(image)" : "";
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1) + "…" : text;
}

/** Summaries, most recently used first. Unreadable files are skipped. */
export function listChats() {
  let names;
  try {
    names = readdirSync(CHAT_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, "");
    if (!name.endsWith(".json") || !validChatId(id)) continue;
    const chat = loadChat(id);
    if (!chat) continue;
    out.push({
      id: chat.id,
      title: chat.title || "(untitled)",
      created: chat.created,
      updated: chat.updated,
      turns: chat.messages.filter((m) => m.role === "user").length,
    });
  }
  return out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
}

/**
 * Delete a chat, and Claude Code's own saved copy of the agent conversation,
 * so a deleted chat is actually gone. Returns false if there was no chat.
 */
export function deleteChat(id) {
  if (!validChatId(id)) return false;
  const chat = loadChat(id);
  if (!chat && !existsSync(fileFor(id))) return false;
  if (chat?.agentSession) deleteAgentTranscript(chat.agentSession);
  rmSync(fileFor(id), { force: true });
  return true;
}

/**
 * Claude Code keeps each session under ~/.claude/projects/<encoded cwd>/.
 * The cwd may have changed since, so every project directory is checked for
 * this session id. Only a well-formed UUID we generated is ever used here.
 */
export function deleteAgentTranscript(sessionId) {
  if (!UUID_RE.test(sessionId ?? "")) return 0;
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  let removed = 0;
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return 0;
  }
  for (const dir of projects) {
    for (const target of [join(root, dir.name, `${sessionId}.jsonl`), join(root, dir.name, sessionId)]) {
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
        removed++;
      }
    }
  }
  return removed;
}
