/**
 * Standing instructions: earlier prompts that still define the task.
 *
 * The gate judges scope against the last five prompts (three substantive, two
 * short). "Keep going with the jevwire fix, and its next release" stops being
 * one of them after a few unrelated messages, and from then on every later step
 * of that same task reads as unrelated. A standing instruction is such a
 * prompt, kept from the whole session and handed to the scope judgment next to
 * the recent ones, tagged with its age.
 *
 * Deliberately simple, so a user can predict it:
 *
 *  - a prompt is a standing instruction when it reads as an ongoing directive
 *    (`DIRECTIVE_PATTERN`: keep going, continue, handle, take care of, finish,
 *    "and its release", from now on, …) and is long enough to name a task, or
 *    when `route_prompts` classified it as a task-defining kind;
 *  - every standing instruction is dropped when the user changes topic or says
 *    the task is done (`TOPIC_CHANGE_PATTERN`);
 *  - the newest `standing_directives` (default 3) not already among the recent
 *    prompts are judged, each clamped, so the cost is bounded by the setting
 *    and never grows with the transcript.
 */

import type { SessionState } from "./store.js";

/** Standing instructions kept in the session file, newest last. */
export const MAX_DIRECTIVES_KEPT = 10;
/** Longest standing instruction kept, and sent. */
export const MAX_DIRECTIVE_CHARS = 600;
/** A directive has to name something: "continue" alone continues the previous prompt. */
const MIN_DIRECTIVE_WORDS = 4;

/** Phrases that mark a prompt as an instruction meant to outlast its turn. */
export const DIRECTIVE_PATTERN =
  /\b(keep (going|at it|working)|carry on|continu(e|ing)|go ahead (and|with)|handle|take care of|finish|follow through|see (it|this) through|all the way|end to end|until (it'?s|it is|its) (done|finished|shipped)|and (its|the|a) (next )?release|ship (it|this)|from now on|for the rest of)\b/i;
/** Phrases that end every standing instruction: a new topic, or the task declared done. */
export const TOPIC_CHANGE_PATTERN =
  /\b(new (task|topic)|different (task|topic|thing)|switch(ing)? (topics?|to something)|change of (plan|topic)|forget (that|about (that|it))|never ?mind|drop (that|it|this)|stop (working on|that|this)|(that'?s|that is|we'?re|it'?s|all) (all )?(done|finished)|done with (that|this|it))\b/i;

/** One standing instruction in the session file. */
export interface Directive {
  /** The prompt, redacted and clamped by the caller. */
  text: string;
  /** The session's prompt counter when it was given. */
  seq: number;
  /** Epoch ms. */
  ts: number;
}

/** A standing instruction as the gate uses it. */
export interface StandingDirective {
  text: string;
  /** How many user prompts ago it was given (1 = the one before the latest). */
  age: number;
}

/** Does this prompt read as an ongoing directive? */
export function isDirective(prompt: string): boolean {
  const text = prompt.trim();
  if (text.split(/\s+/).length < MIN_DIRECTIVE_WORDS) return false;
  return DIRECTIVE_PATTERN.test(text);
}

/** Does this prompt change topic, or say the task is done? */
export function isTopicChange(prompt: string): boolean {
  return TOPIC_CHANGE_PATTERN.test(prompt);
}

/**
 * The session's standing instructions after `prompt`.
 *
 * A topic change clears the list first; the prompt that changed topic can
 * still start a new list of its own ("forget that — keep going with the
 * parser fix instead").
 */
export function nextDirectives(
  existing: readonly Directive[],
  prompt: string,
  seq: number,
  now: number,
  forceDirective = false,
): Directive[] {
  const text = prompt.trim().slice(0, MAX_DIRECTIVE_CHARS);
  const kept = isTopicChange(text) ? [] : existing.filter((d) => d.text !== text);
  if (text !== "" && (forceDirective || isDirective(text))) kept.push({ text, seq, ts: now });
  return kept.slice(-MAX_DIRECTIVES_KEPT);
}

/** Validate directives read back off disk. */
export function readDirectives(raw: unknown): Directive[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter(
    (d): d is Directive =>
      typeof d === "object" &&
      d !== null &&
      typeof (d as Directive).text === "string" &&
      typeof (d as Directive).seq === "number" &&
      Number.isFinite((d as Directive).seq) &&
      typeof (d as Directive).ts === "number",
  );
  return out.length === 0 ? undefined : out.slice(-MAX_DIRECTIVES_KEPT).map((d) => ({ ...d, text: d.text.slice(0, MAX_DIRECTIVE_CHARS) }));
}

/**
 * The standing instructions a judgment should carry, newest first.
 *
 * Those still among the recent prompts are left out — they are already in the
 * request — and at most `limit` are returned.
 */
export function standingDirectives(session: Pick<SessionState, "prompts" | "directives" | "prompt_seq">, limit: number): StandingDirective[] {
  if (limit <= 0) return [];
  const recent = new Set(session.prompts.map((p) => p.trim()));
  const seq = session.prompt_seq ?? 0;
  const out: StandingDirective[] = [];
  const all = session.directives ?? [];
  for (let index = all.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const directive = all[index] as Directive;
    if (recent.has(directive.text.trim())) continue;
    out.push({ text: directive.text, age: Math.max(1, seq - directive.seq) });
  }
  return out;
}

/** How every tagged standing instruction in `request.previous` starts. */
export const STANDING_PREFIX = "[standing instruction from ";

/** The tag a standing instruction carries into `request.previous`. */
export function standingTag(directive: StandingDirective): string {
  return `${STANDING_PREFIX}${directive.age} prompt${directive.age === 1 ? "" : "s"} ago] ${directive.text}`;
}
