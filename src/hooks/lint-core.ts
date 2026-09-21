/**
 * The model half of the semantic code lint: the questions, the state the model
 * sees, and the pure outcome table that turns firm findings into a trip, a note
 * or silence.
 *
 * zod-free, so it bundles into `hook.mjs`. The regex gate in `lint-prefilter.ts`
 * has already decided which questions to ask; this asks them and reads the
 * answers. Two findings are block-grade (a hardcoded secret, a removed test the
 * user did not ask to remove); everything else is an advisory note.
 */

import { lean } from "../decision/policy.js";
import type { DecisionModel, EvaluateRequest, GateThresholds, Json, NoulAnswer, Question } from "../decision/types.js";
import type { LintLevel } from "./config.js";
import { LINT_QUESTION_IDS, type LintQuestionId } from "./lint-prefilter.js";

export { LINT_QUESTION_IDS };
export type { LintQuestionId };

/** The two findings that deny the call rather than note it. */
export const TRIP_FINDINGS: readonly LintQuestionId[] = ["hardcodes_secret", "removes_test"];

/** Longest new/old text the state carries (head + tail, as the screen clips). */
const MAX_LINT_TEXT = 12_000;
/** Longest lines list either side of the diff. */
const MAX_LINT_LINES = 120;

export interface LintJudgeInput {
  file_path: string;
  language: string;
  change: { kind: "edit" | "write" | "multi_edit"; old_string?: string; new_string?: string; content?: string };
  removed_lines: string[];
  added_lines: string[];
  user_request?: string | undefined;
  conventions: string[];
}

/** Clip long text to a head and a tail, so one huge line cannot dominate. */
function clip(text: string, max = MAX_LINT_TEXT): string {
  if (text.length <= max) return text;
  const head = Math.floor((max * 2) / 3);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (max - head))}`;
}

export function lintState(input: LintJudgeInput): Record<string, Json> {
  const change: Record<string, Json> = { kind: input.change.kind };
  if (input.change.old_string !== undefined) change.old_string = clip(input.change.old_string);
  if (input.change.new_string !== undefined) change.new_string = clip(input.change.new_string);
  if (input.change.content !== undefined) change.content = clip(input.change.content);
  const state: Record<string, Json> = {
    file_path: input.file_path,
    language: input.language,
    change,
    removed_lines: input.removed_lines.slice(0, MAX_LINT_LINES),
    added_lines: input.added_lines.slice(0, MAX_LINT_LINES),
    conventions: input.conventions,
  };
  if (input.user_request !== undefined) state.user_request = input.user_request;
  return state;
}

// --------------------------------------------------------------- the questions

const QUESTIONS: Record<LintQuestionId, Question> = {
  removes_test: {
    type: "noul",
    instructions: {
      question: "Does the change remove or disable a test, a test case, or an assertion?",
      inspect: ["removed_lines", "added_lines"],
      focus: "Compare what was asserted before with what is asserted after.",
    },
    criteria: {
      true: {
        what: "A test, test case, expectation or assertion that existed in `old_string` is gone from `new_string`, or is skipped, commented out, or made to pass unconditionally.",
        examples: ["an `expect(...)` line deleted", "`it(` changed to `it.skip(`", "an assertion replaced by a log statement"],
      },
      false: {
        what: "Every test and assertion that existed is still present and still checks the same thing; tests may have been added, renamed, or moved without weakening.",
        not_for: "renaming a test, reordering assertions, updating an expected value alongside the code it tests",
      },
    },
  },
  swallows_exception: {
    type: "noul",
    instructions: {
      question: "Does the change add a handler that catches an error and then discards it?",
      inspect: "added_lines",
    },
    criteria: {
      true: {
        what: "A new catch/except/rescue block whose body neither rethrows, returns an error value, nor records the error somewhere a person would see it.",
        examples: ["`catch {}`", "`except Exception: pass`", "`catch (e) { console.log(e) }` as the only handling"],
      },
      false: {
        what: "No new handler, or the new handler rethrows, propagates, fails the operation, or reports the error.",
        not_for: "a handler that maps the error to a typed result or a user-facing message",
      },
    },
  },
  hardcodes_secret: {
    type: "noul",
    instructions: {
      question: "Does the change write a real credential into the code as a literal?",
      inspect: "added_lines",
    },
    criteria: {
      true: {
        what: "An API key, access token, password, private key or signing secret appears as a literal string value in `added_lines`.",
        examples: ["`apiKey = \"sk-live-…\"`", "a `-----BEGIN PRIVATE KEY-----` block", "`Authorization: Bearer eyJ…` with a full token"],
      },
      false: {
        what: "The value is read from the environment, a config file or a secret store, or the literal is plainly a placeholder or example.",
        examples: ["`process.env.API_KEY`", '`"your-key-here"`', '`"<token>"`', "a test fixture named as fake"],
      },
    },
  },
  hardcodes_url_or_path: {
    type: "noul",
    instructions: {
      question: "Does the change write an environment-specific URL or absolute filesystem path into code as a literal?",
      inspect: "added_lines",
    },
    criteria: {
      true: {
        what: "A literal URL naming a specific host, or an absolute path under a home directory or system directory, is used by the code rather than read from configuration.",
        examples: ['`fetch("https://api.internal.example.com/v2")`', '`open("/Users/dana/data.csv")`'],
      },
      false: {
        what: "The value comes from configuration or an argument, or the literal is a public constant such as a schema URL, a documentation link in a comment, or a path inside the project.",
        not_for: "URLs in comments or docs, `localhost` in tests, relative paths",
      },
    },
  },
  adds_suppression: {
    type: "noul",
    instructions: {
      question: "Does the change add a type or lint suppression that did not exist before?",
      inspect: ["added_lines", "removed_lines"],
    },
    criteria: {
      true: {
        what: "A new `any` type, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `# type: ignore`, `# noqa` or equivalent that silences a check on code in this change.",
      },
      false: {
        what: "No new suppression; an existing one moved; the word appears in a comment or string; or the suppression carries a justification comment on the same or previous line.",
        not_for: "`any` in prose or in a type test, `@ts-expect-error` with a reason",
      },
    },
  },
  changes_public_signature: {
    type: "noul",
    instructions: {
      question: "Does the change alter the parameters, return type or name of something exported from this file?",
      inspect: ["removed_lines", "added_lines"],
    },
    criteria: {
      true: {
        what: "An exported function, method, class, type or constant has a different name, parameter list, parameter types or return type after the change, or is no longer exported.",
        examples: ["`export function run(a)` becomes `export function run(a, b)`", "an exported type loses a field"],
      },
      false: {
        what: "Exported signatures are unchanged; only bodies, private helpers, comments or new exports changed.",
        not_for: "adding a new export, changing a non-exported function",
      },
    },
  },
  leaves_placeholder: {
    type: "noul",
    instructions: {
      question: "Does the change leave a placeholder where working code was asked for?",
      inspect: "added_lines",
    },
    criteria: {
      true: {
        what: "The added code contains a TODO, FIXME, stub, `not implemented` error, bare `pass`, or ellipsis standing in for logic that the surrounding code needs.",
        examples: ['`throw new Error("not implemented")` in a function that is called', "`// TODO: handle errors` with no handling"],
      },
      false: {
        what: "No placeholder, or the marker is in a comment describing future work that the change does not depend on.",
        not_for: "a TODO in documentation, a deliberate `pass` in an abstract method",
      },
    },
  },
};

const REQUESTED_REMOVAL: Question = {
  type: "noul",
  instructions: "Does `user_request` ask for a test or an assertion to be removed, skipped or changed?",
  criteria: {
    true: "`user_request` names a test, test file or assertion and asks for it to be deleted, skipped, disabled or rewritten.",
    false: "`user_request` does not mention removing or changing tests.",
  },
};

function conventionQuestion(index: number): Question {
  return {
    type: "noul",
    instructions: {
      question: `Does the change go against \`conventions[${index}]\`?`,
      inspect: ["added_lines"],
      focus: `Judge only what \`conventions[${index}]\` literally says, against the added lines.`,
    },
    criteria: {
      true: `\`added_lines\` do something \`conventions[${index}]\` says not to do, or omit something it says to always do.`,
      false: `\`conventions[${index}]\` is followed, or it is about something this change does not touch.`,
    },
  };
}

/** Build the question set: the gated findings, `requested_removal` when relevant, and one per convention. */
export function lintQuestions(
  ask: readonly LintQuestionId[],
  conventions: readonly string[],
  hasRequest: boolean,
): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const id of ask) questions[id] = QUESTIONS[id];
  if (ask.includes("removes_test") && hasRequest) questions.requested_removal = REQUESTED_REMOVAL;
  conventions.forEach((_convention, index) => {
    questions[`conv_${index}`] = conventionQuestion(index);
  });
  return questions;
}

// --------------------------------------------------------------- outcome table

export interface LintFinding {
  id: string;
  p: number;
  /** For a convention finding, the line text. */
  convention?: string | undefined;
}

export interface LintOutcome {
  outcome: "silent" | "note" | "trip";
  findings: LintFinding[];
  /** The trip's finding id, when `outcome === "trip"`. */
  trip?: "hardcodes_secret" | "removes_test";
  suppressed?: "uncertain" | "dup" | "cap" | "requested-removal" | "level";
}

export interface LintOutcomeInput {
  signals: Record<string, number>;
  conventions: readonly string[];
  thresholds: GateThresholds;
  duplicate: boolean;
  notesThisPrompt: number;
  cap: number;
  level: LintLevel;
}

/**
 * Turn the model's answers into a trip, a note, or silence. Pure; first match
 * wins, in the order the design fixes.
 *
 * A hardcoded secret trips. A removed test trips unless the user asked for it
 * (then it is a note). Any other firm finding is a note when the level is
 * advisory, and silent when the level is tripwire (which keeps only the two
 * block-grade checks). Nothing firm is silent.
 */
export function lintOutcome(input: LintOutcomeInput): LintOutcome {
  const { signals, thresholds } = input;
  const firm = (id: string): boolean => lean(signals[id] ?? 0, thresholds.auto) === "yes";

  const findings: LintFinding[] = [];
  for (const id of LINT_QUESTION_IDS) {
    if (firm(id)) findings.push({ id, p: signals[id] ?? 0 });
  }
  input.conventions.forEach((convention, index) => {
    if (firm(`conv_${index}`)) findings.push({ id: `conv_${index}`, p: signals[`conv_${index}`] ?? 0, convention });
  });

  if (input.level === "off") return { outcome: "silent", findings: [], suppressed: "level" };

  if (firm("hardcodes_secret")) {
    return { outcome: "trip", findings, trip: "hardcodes_secret" };
  }
  if (firm("removes_test")) {
    if (!firm("requested_removal")) return { outcome: "trip", findings, trip: "removes_test" };
    // The user asked for it: a note, not a block.
    return note(findings, input, "removes_test-requested");
  }

  if (findings.length === 0) return { outcome: "silent", findings, suppressed: "uncertain" };
  if (input.level === "tripwire") return { outcome: "silent", findings, suppressed: "level" };

  return note(findings, input);
}

function note(findings: LintFinding[], input: LintOutcomeInput, _reason?: string): LintOutcome {
  if (input.duplicate) return { outcome: "silent", findings, suppressed: "dup" };
  if (input.notesThisPrompt >= input.cap) return { outcome: "silent", findings, suppressed: "cap" };
  return { outcome: "note", findings };
}

export interface LintRunResult {
  signals: Record<string, number>;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  latency_ms: number;
  memo?: boolean;
}

/** One request that asks the gated questions, returning each answer's `P(yes)`. */
export async function runLint(
  model: DecisionModel,
  state: Record<string, Json>,
  questions: Record<string, Question>,
  signal?: AbortSignal,
): Promise<LintRunResult> {
  const request: EvaluateRequest = { state, questions };
  if (signal !== undefined) request.signal = signal;
  const result = await model.evaluate(request);
  const answers = result.answers as Record<string, NoulAnswer | undefined>;
  const signals: Record<string, number> = {};
  for (const id of Object.keys(questions)) {
    const answer = answers[id];
    signals[id] = answer !== undefined && answer.type === "noul" && typeof answer.noul === "number" ? answer.noul : 0;
  }
  return {
    signals,
    usage: result.usage,
    model: result.model,
    latency_ms: result.latency_ms,
    ...(result.memo === true ? { memo: true } : {}),
  };
}
