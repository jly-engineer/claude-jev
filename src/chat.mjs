import { askJev, decide } from "./router.mjs";
import { tierSpec } from "./config.mjs";

/**
 * Chat turns, routed the same way Claude Code turns are.
 *
 * The dashboard's chat panel does NOT send the `jev-auto` sentinel. The proxy
 * only routes requests that carry tools, which is how it tells a real turn
 * from a tool-loop continuation — a toolless chat request would fall through
 * and sit on the default tier forever. So this asks Jev directly and sends a
 * concrete model. The request still goes through the proxy, so usage lands in
 * the ledger and shows up in the savings figures like anything else.
 *
 * No `thinking` is requested. Tier can change between turns, and thinking
 * block signatures are bound to the model that produced them — not asking for
 * them at all sidesteps that entirely.
 */

const MAX_TURNS = 40;
const sessions = new Map();
const MAX_SESSIONS = 20;

/** Per-conversation history and pinned tier. */
export function session(id) {
  let s = sessions.get(id);
  if (s) {
    sessions.delete(id);
  } else {
    s = { messages: [], tier: "haiku" };
  }
  sessions.set(id, s);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  return s;
}

export function resetSession(id) {
  sessions.delete(id);
}

/**
 * Pick a tier for this prompt and build the upstream request body.
 * Returns { body, tier, previous, confidence, reason, ms }.
 */
export async function planTurn(s, text) {
  const previous = s.tier;
  const jev = await askJev(text);
  const { tier, reason } = decide({ jev, current: s.tier });
  s.tier = tier;

  const spec = tierSpec(tier);
  const messages = [...s.messages, { role: "user", content: text }].slice(-MAX_TURNS);

  const body = {
    model: spec.id,
    max_tokens: 4096,
    messages,
    stream: true,
  };
  if (spec.effort) body.output_config = { effort: spec.effort };

  return {
    body,
    tier,
    previous,
    model: spec.id,
    confidence: jev?.confidence ?? null,
    reason,
    ms: jev?.ms ?? null,
  };
}

/** Commit a completed exchange to the session history. */
export function commitTurn(s, userText, assistantText) {
  s.messages.push({ role: "user", content: userText });
  if (assistantText) s.messages.push({ role: "assistant", content: assistantText });
  if (s.messages.length > MAX_TURNS) s.messages = s.messages.slice(-MAX_TURNS);
}
