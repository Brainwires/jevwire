/**
 * Whether a `# jev:intended` marker counts: the one decision every marker path
 * in the PreToolUse hook shares.
 *
 * Verified mode, the default: the marker has to carry a quote, and the quote
 * has to be found in one of the user's own messages — the session transcript's
 * genuine user entries, plus the prompts `UserPromptSubmit` recorded, which
 * cover a transcript that has not been flushed yet or cannot be read. Nothing
 * else is consulted, and a miss is a refusal: there is no fallback to trust.
 *
 * Legacy mode (`legacy_markers`): the 0.7.1 rule. An unquoted marker of at
 * least `MIN_AFFIRM_CHARS` is accepted as written; a quoted one is still looked
 * up, logged as verified when found, and accepted on trust when not.
 *
 * Pure apart from the transcript read, which happens only when the marker has
 * a quote to look up.
 */

import { readUserMessages, normalizeQuote, verifyQuote, type QuoteMatch, type UserMessage } from "./transcript.js";
import { MIN_AFFIRM_CHARS, type AffirmationMarker } from "./tripwire.js";
import type { MarkerRefusal } from "./wording.js";

export type MarkerCheck =
  /** The quote was found in a user message. */
  | { status: "verified"; match: QuoteMatch }
  /** Accepted on trust under `legacy_markers`. */
  | { status: "legacy" }
  /** Refused: the call is not cleared, and the agent is told why. */
  | { status: "unverified"; why: MarkerRefusal }
  /** Legacy mode only: an unquoted reason too short to count, treated as absent. */
  | { status: "short" };

export interface MarkerContext {
  legacy: boolean;
  transcriptPath: string | undefined;
  /** The prompts the session file holds, oldest first. */
  prompts: readonly string[];
}

/**
 * The user's messages: the transcript's, then any recorded prompt the
 * transcript does not already hold (newest, so it counts as the latest).
 */
export function userMessages(transcriptPath: string | undefined, prompts: readonly string[]): UserMessage[] {
  const messages = readUserMessages(transcriptPath);
  const seen = new Set(messages.map((m) => normalizeQuote(m.text)));
  for (const prompt of prompts) {
    const key = normalizeQuote(prompt);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    messages.push({ text: prompt });
  }
  return messages;
}

export function checkMarker(marker: AffirmationMarker, context: MarkerContext): MarkerCheck {
  if (marker.quote !== undefined) {
    const verdict = verifyQuote(marker.quote, userMessages(context.transcriptPath, context.prompts));
    if (verdict.ok) return { status: "verified", match: verdict.match };
    if (context.legacy && (marker.reason ?? "").length >= MIN_AFFIRM_CHARS) return { status: "legacy" };
    return { status: "unverified", why: verdict.why };
  }
  if (!context.legacy) return { status: "unverified", why: "no-quote" };
  return marker.short ? { status: "short" } : { status: "legacy" };
}

/** Is this a marker that clears a classifier trip? */
export function markerAccepted(check: MarkerCheck | undefined): boolean {
  return check?.status === "verified" || check?.status === "legacy";
}
