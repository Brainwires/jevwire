/**
 * The user's own words, read from Claude Code's session transcript, and the
 * check that a `# jev:intended "<quote>"` marker quotes them.
 *
 * Until 0.7.2 a marker was trusted: any `# jev:intended <sentence>` passed a
 * tripped call, and the sentence was whatever the agent chose to write. Now the
 * marker has to carry a quote, and the quote has to be found — after
 * whitespace, case and punctuation are normalized away — inside one message
 * the human actually typed. The agent can still quote the wrong sentence; it
 * can no longer quote a sentence nobody said.
 *
 * What counts as "a message the human typed" is the whole point, so it is
 * deliberately narrow. A transcript line is a JSON object; the ones kept are
 * `type: "user"` entries that are not meta, not a sidechain, not a compact
 * summary, and not a tool result. From those, only text survives, and inside
 * that text every block a harness or hook injects is cut out first:
 * `<system-reminder>`, `<task-notification>`, local-command output, slash
 * command wrappers, and `<pasted_content>`-style blocks. A tool result is
 * where an injected instruction would come from, so a tool result is never a
 * place a quote can be found.
 *
 * Everything here is synchronous and best-effort: an unreadable transcript is
 * an empty list, never a throw, and the caller decides what an empty list
 * means (in verified mode: the marker is refused).
 */

import { readFileSync, statSync } from "node:fs";

/** Read at most this much of a transcript: its tail, when it is longer. */
export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
/**
 * The fewest words a quote may have, unless it is the user's whole message.
 *
 * Three, not two: "the release" or "push it" turn up inside a great many
 * sentences that ask for something else entirely. A short message is still
 * quotable whole — "yes", "ship it", "make it so" — which is the case the
 * shorter quote was for.
 */
export const MIN_QUOTE_WORDS = 3;

/** Tags whose contents a harness or hook wrote, not the user. */
const INJECTED_TAGS = [
  "system-reminder",
  "task-notification",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "command-name",
  "command-message",
  "bash-stdout",
  "bash-stderr",
  "user-prompt-submit-hook",
  "hook-output",
  "pasted_content",
  "pasted-content",
];
const INJECTED_BLOCK = new RegExp(
  `<(${INJECTED_TAGS.map((tag) => tag.replace(/[-_]/g, "[-_]")).join("|")})\\b[^>]*>[\\s\\S]*?(?:</\\1\\s*>|$)`,
  "gi",
);
/** Fixed strings Claude Code writes into a user entry on the user's behalf. */
const HARNESS_LINES = /^\[(?:Request interrupted by user[^\]]*|Image #\d+[^\]]*)\]\s*$/gim;

/** One genuine user message, oldest first in a list. */
export interface UserMessage {
  text: string;
}

/** The text a user entry's `message.content` carries, or undefined for a tool result. */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  // An entry that carries a tool result is a tool result, whatever text
  // blocks ride along with it.
  if (content.some((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_result")) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === "text" && typeof text === "string") parts.push(text);
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

/** Cut every injected block and harness line out of a user entry's text. */
export function stripInjected(text: string): string {
  return text
    .replace(INJECTED_BLOCK, " ")
    .replace(HARNESS_LINES, " ")
    .replace(/<\/?command-args\s*>/gi, " ")
    .trim();
}

/**
 * The genuine user text of one transcript line, or undefined.
 *
 * Exported for the tests, which feed it real-shaped lines one at a time.
 */
export function userTextOf(line: string): string | undefined {
  // Cheap reject before a parse: most lines in a long transcript are
  // assistant turns and tool traffic.
  if (!line.includes('"user"')) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof entry !== "object" || entry === null) return undefined;
  const value = entry as Record<string, unknown>;
  if (value.type !== "user") return undefined;
  if (value.isMeta === true || value.isSidechain === true || value.isCompactSummary === true) return undefined;
  if (value.toolUseResult !== undefined) return undefined;
  const message = value.message as { role?: unknown; content?: unknown } | undefined;
  if (typeof message !== "object" || message === null) return undefined;
  if (message.role !== undefined && message.role !== "user") return undefined;
  const raw = contentText(message.content);
  if (raw === undefined) return undefined;
  const text = stripInjected(raw);
  return text === "" ? undefined : text;
}

/** Every genuine user message in a JSONL transcript's text, oldest first. */
export function parseUserMessages(jsonl: string): UserMessage[] {
  const out: UserMessage[] = [];
  for (const line of jsonl.split("\n")) {
    const text = userTextOf(line);
    if (text !== undefined) out.push({ text });
  }
  return out;
}

/**
 * Read the genuine user messages out of the transcript at `path`.
 *
 * Only a `.jsonl` path is read: the path arrives in the hook input, and the
 * daemon answering it should not open whatever file a request names. Past
 * `MAX_TRANSCRIPT_BYTES` only the tail is read, whose first (partial) line is
 * dropped by the parser like any other line that does not parse.
 */
export function readUserMessages(path: string | undefined): UserMessage[] {
  if (path === undefined || path === "" || !path.endsWith(".jsonl")) return [];
  try {
    const size = statSync(path).size;
    if (size <= MAX_TRANSCRIPT_BYTES) return parseUserMessages(readFileSync(path, "utf8"));
    const buffer = readFileSync(path);
    return parseUserMessages(buffer.subarray(buffer.length - MAX_TRANSCRIPT_BYTES).toString("utf8"));
  } catch {
    return [];
  }
}

/**
 * Lowercase, punctuation to spaces, whitespace collapsed.
 *
 * Applied to both sides of the match, so a quote survives the agent re-typing
 * curly quotes as straight ones, dropping a comma, or changing case. Letters
 * and digits in any script are kept; everything else is a word break.
 */
export function normalizeQuote(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['‘’ʼ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function wordCount(normalized: string): number {
  return normalized === "" ? 0 : normalized.split(" ").length;
}

/** Where a quote was found. */
export interface QuoteMatch {
  /** 0 for the newest user message, 1 for the one before it, and so on. */
  age: number;
  /** The matched message, as the user wrote it. Not redacted: the caller does that. */
  message: string;
}

export type QuoteVerdict =
  | { ok: true; match: QuoteMatch }
  | { ok: false; why: "empty" | "too-short" | "not-found" };

/**
 * Is `quote` in one of `messages`?
 *
 * Whole words only: the normalized quote has to sit between word breaks of the
 * normalized message, so "push" is not found inside "pushover". A quote of
 * fewer than `MIN_QUOTE_WORDS` words counts only as the whole of a message —
 * "yes" quotes a message that was "yes", not one that says "yes, but not the
 * deploy". The newest message wins when several match.
 */
export function verifyQuote(quote: string, messages: readonly UserMessage[]): QuoteVerdict {
  const wanted = normalizeQuote(quote);
  if (wanted === "") return { ok: false, why: "empty" };
  const short = wordCount(wanted) < MIN_QUOTE_WORDS;
  let shortMiss = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as UserMessage;
    const normalized = normalizeQuote(message.text);
    if (!` ${normalized} `.includes(` ${wanted} `)) continue;
    if (short && normalized !== wanted) {
      shortMiss = true;
      continue;
    }
    return { ok: true, match: { age: messages.length - 1 - index, message: message.text } };
  }
  return { ok: false, why: shortMiss ? "too-short" : "not-found" };
}
