/**
 * The commit-time half of the code lint: when a `git commit` is about to run,
 * judge the staged diff for scope and for whether the message describes it, and
 * catch a secret written straight into the diff (a Bash heredoc the edit lint
 * never saw).
 *
 * A note, never a block, for scope and message — the model does not count hunks,
 * so `pr_scope` is a gestalt read of the diff, thresholded on the mass of the
 * "several independent changes" level, never on a number it computed. Only a
 * hardcoded secret trips, and that is a firm yes/no.
 */

import { lean, levelMass } from "../decision/policy.js";
import type { GateThresholds, Json, NoulAnswer, Question, ScoreAnswer } from "../decision/types.js";

/** Level index of the "several independent changes" outcome. */
const SCOPE_SEVERAL = 2;

export const COMMIT_QUESTIONS: Record<string, Question> = {
  pr_scope: {
    type: "score",
    instructions: {
      question: "How focused is `diff` on a single change?",
      note: "Judge the number of independent changes, not the size of any one change. `stat` lists the files touched.",
    },
    criteria: [
      {
        summary: "One change, clearly stated",
        signals: ["Every hunk serves the same fix or feature", "Files touched are the ones that change needs"],
      },
      {
        summary: "One main change plus a small related tweak",
        signals: ["A primary change and one minor adjacent edit", "The tweak supports the main change"],
      },
      {
        summary: "Several independent changes bundled together",
        signals: [
          "Two or more unrelated fixes or features",
          "Hunks that could each be their own commit",
          "Formatting or renames across files unrelated to the main change",
        ],
      },
    ],
  },
  message_describes_diff: {
    type: "noul",
    instructions: "Does `commit_message` describe the changes in `diff`?",
    criteria: {
      true: "Every change in `diff` is covered by `commit_message`, at the level of what changed and why.",
      false: "`commit_message` names a change `diff` does not contain, or leaves a substantial part of `diff` unmentioned.",
    },
  },
  hardcodes_secret: {
    type: "noul",
    instructions: {
      question: "Do the added lines of `diff` write a real credential into the code as a literal?",
      inspect: "added_lines",
    },
    criteria: {
      true: {
        what: "An API key, access token, password, private key or signing secret appears as a literal string value in an added line.",
        examples: ['`+ const apiKey = "sk-live-…"`', "an added `-----BEGIN PRIVATE KEY-----` block"],
      },
      false: {
        what: "The value is read from the environment or a secret store, or the literal is plainly a placeholder or example.",
        examples: ["`+ process.env.API_KEY`", '`+ "your-key-here"`'],
      },
    },
  },
};

export interface CommitStateInput {
  commit_message?: string | undefined;
  stat: string;
  diff: string;
  added_lines: string[];
  user_request?: string | undefined;
  /** Whether a secret gate fired in code; when false, the secret question is dropped. */
  askSecret: boolean;
  /** Whether the command carried a `-m`/`-F` message; when false, the message question is dropped. */
  hasMessage: boolean;
}

export function commitState(input: CommitStateInput): Record<string, Json> {
  const state: Record<string, Json> = { stat: input.stat, diff: input.diff, added_lines: input.added_lines };
  if (input.commit_message !== undefined) state.commit_message = input.commit_message;
  if (input.user_request !== undefined) state.user_request = input.user_request;
  return state;
}

/** The questions to ask for this commit: scope always, message with a message, secret when the gate fired. */
export function commitQuestions(input: Pick<CommitStateInput, "askSecret" | "hasMessage">): Record<string, Question> {
  const questions: Record<string, Question> = { pr_scope: COMMIT_QUESTIONS.pr_scope as Question };
  if (input.hasMessage) questions.message_describes_diff = COMMIT_QUESTIONS.message_describes_diff as Question;
  if (input.askSecret) questions.hardcodes_secret = COMMIT_QUESTIONS.hardcodes_secret as Question;
  return questions;
}

export interface CommitAnswers {
  pr_scope?: ScoreAnswer | undefined;
  message_describes_diff?: NoulAnswer | undefined;
  hardcodes_secret?: NoulAnswer | undefined;
}

export interface CommitOutcome {
  /** `P(several independent changes)`, or undefined when the answer carried no level probabilities. */
  scope_p3: number | undefined;
  /** The diff bundles several independent changes, firmly. */
  scopeNote: boolean;
  /** The message firmly does not describe the diff. */
  messageNote: boolean;
  /** The diff adds a hardcoded secret, firmly. */
  secretTrip: boolean;
  message_describes: number | undefined;
}

/**
 * Turn the answers into notes and a possible trip. Pure. `pr_scope` is firm
 * only on the mass of the top level (never the expectation); the message note
 * fires on a firm no; the secret trips on a firm yes.
 */
export function commitOutcome(answers: CommitAnswers, thresholds: GateThresholds): CommitOutcome {
  const scopeP3 = answers.pr_scope !== undefined ? levelMass(answers.pr_scope, [SCOPE_SEVERAL]) : undefined;
  const describes = answers.message_describes_diff?.noul;
  const secret = answers.hardcodes_secret?.noul;
  return {
    scope_p3: scopeP3,
    scopeNote: scopeP3 !== undefined && scopeP3 >= thresholds.auto,
    messageNote: describes !== undefined && lean(describes, thresholds.auto) === "no",
    secretTrip: secret !== undefined && lean(secret, thresholds.auto) === "yes",
    message_describes: describes,
  };
}

/** The `+` lines of a unified diff (excluding the `+++` header), for the secret gate. */
export function addedLinesOf(diff: string): string[] {
  return diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
}
