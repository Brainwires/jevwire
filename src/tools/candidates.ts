/**
 * Shared pieces for the two tools that judge a list of caller-supplied
 * candidates against a question: `jev_rank` (a Noul per candidate, for order)
 * and `jev_pick` (one Choice over the candidates, for a single pick).
 *
 * The one rule both obey: the model never sees candidate ids. An id is an
 * arbitrary caller string — a file path, a grep line, a symbol — and putting it
 * in the state is both a distractor (a 40-char path head can outrank the code
 * it names) and unsafe as a question key. Candidates go in as an index-keyed
 * array and the zero-based indices are mapped back to ids in code.
 */

import type { ChoiceAnswer, Json } from "../decision/types.js";

/** One candidate, with its position in the caller's input array as the tie-break. */
export interface Entry {
  id: string;
  text: string;
  /** Position in the caller's input array; the stable tie-break. */
  index: number;
  /** File sources only (`jev_rank`): where this text came from. */
  where?: { path: string; start_line: number; end_line: number } | undefined;
}

/**
 * The candidate texts as the array that goes into the state under `candidates`.
 * The question keys `"0".."n-1"` index into it, so order here is the contract.
 */
export function indexKeyedState(entries: readonly Entry[]): Json[] {
  return entries.map((entry) => entry.text);
}

/** Narrow a possibly-absent answer to a Choice. */
export function isChoice(answer: { type?: string } | undefined): answer is ChoiceAnswer {
  return answer !== undefined && answer.type === "choice";
}
