/**
 * `jev_pick` — choose one candidate from a list the caller already has.
 *
 * The list is grep hits, symbols, failing test names, file paths: things a
 * search produced. Instead of the agent guessing which one the question means,
 * Jev answers one Choice over the candidate indices (plus a `none` escape
 * hatch) and one absolute yes/no per candidate. `pick` is always one of the
 * caller's ids or `null`; it cannot invent a value.
 *
 * One request, never chunked: a Choice split across requests is not a single
 * pick, so an over-budget candidate set is a caller error, not something to
 * fan out. `jev_rank` is the tool for "order many, possibly long, passages".
 */

import { z } from "zod";
import { BudgetError, DEFAULT_BUDGET_LIMITS, estimateBudget, fitsBudget } from "../decision/budget.js";
import { gateChoice, resolveThresholds } from "../decision/policy.js";
import type {
  ChoiceAnswer,
  DecisionModel,
  EvaluateRequest,
  Json,
  NoulAnswer,
  Question,
} from "../decision/types.js";
import { indexKeyedState, isChoice, type Entry } from "./candidates.js";
import { envelopeShape, gateSchema, thresholdsSchema, type ToolConfig } from "./shared.js";

export const name = "jev_pick";

export const description = [
  "Choose one candidate from a list you already have — grep hits, symbols, failing test names, file paths — instead of guessing. One Choice over the candidate ids plus a `none` escape hatch, and one absolute yes/no per candidate.",
  "Use it after a search has produced the candidates. It cannot invent a value: `pick` is always one of your ids or null.",
  "`probabilities` are relative (they sum to 1 across candidates and `none`); `fits` is absolute per candidate. Read both: a confident `pick` whose `fits` is under 0.3 is the nearest miss, not a match.",
  "Up to 240 candidates in one call. Keep each `text` to what identifies it (the matching line plus a little context); for ranking many long passages use `jev_rank`.",
].join("\n");

const candidateSchema = z.object({
  id: z.string().min(1).describe("Your identifier for this candidate. Returned as-is; never shown to the model."),
  text: z.string().min(1).describe("What identifies this candidate: the matching line plus a little context."),
});

export const inputShape = {
  question: z.string().min(1).describe("What you are choosing, e.g. 'Which grep hit is the definition of parseConfig?'"),
  candidates: z
    .array(candidateSchema)
    .min(2)
    .max(240)
    .describe("The candidates to choose among, 2 to 240. Ids must be unique and none may be 'none'."),
  none_label: z
    .string()
    .optional()
    .describe("What it means for no candidate to be the one. Defaults to a generic description."),
  thresholds: thresholdsSchema,
} as const;

export const inputSchema = z.object(inputShape);
export type PickToolInput = z.infer<typeof inputSchema>;

export const outputShape = {
  pick: z.string().nullable().describe("The id of the chosen candidate, or null when `none` won."),
  confidence: z.number().describe("How peaked the Choice distribution is, 0..1. Gates on this, not on `fits`."),
  probabilities: z
    .record(z.string(), z.number())
    .describe("Relative: P(each candidate is the one) plus `none`, summing to 1 across all of them."),
  fits: z
    .record(z.string(), z.number())
    .describe("Absolute per candidate: P(this is exactly what the question asks for), on its own."),
  gate: gateSchema.describe("auto/review/escalate on the Choice `confidence`."),
  ...envelopeShape,
} as const;

export const outputSchema = z.object(outputShape);
export type PickToolOutput = z.infer<typeof outputSchema>;

/** The `none` option key. Reserved, so a caller id may not collide with it. */
export const NONE_KEY = "none";

/** A caller error in the candidate set: unique ids, none named `none`. */
export class PickInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PickInputError";
  }
}

function pickQuestion(n: number, noneLabel: string | undefined): Question {
  const criteria: Record<string, string | null> = {};
  for (let i = 0; i < n; i += 1) criteria[String(i)] = null;
  criteria[NONE_KEY] =
    noneLabel !== undefined && noneLabel.trim() !== ""
      ? noneLabel.trim()
      : "None of the entries in `candidates` is what `question` asks for.";
  return {
    type: "choice",
    instructions:
      "Which entry of `candidates` is the one `question` asks for? The option names are the zero-based indices into `candidates`.",
    criteria,
  };
}

function fitsQuestion(localIndex: number): Question {
  return {
    type: "noul",
    instructions: `Is \`candidates[${localIndex}]\` the specific thing \`question\` asks for, on its own?`,
    criteria: {
      true: `\`candidates[${localIndex}]\` is exactly the thing \`question\` asks for.`,
      false: `\`candidates[${localIndex}]\` is something else, or only related to it.`,
    },
  };
}

function buildRequest(entries: readonly Entry[], question: string, noneLabel: string | undefined): {
  state: Record<string, Json>;
  questions: Record<string, Question>;
} {
  const state: Record<string, Json> = { question, candidates: indexKeyedState(entries) };
  const questions: Record<string, Question> = { pick: pickQuestion(entries.length, noneLabel) };
  entries.forEach((_entry, localIndex) => {
    questions[`fits_${localIndex}`] = fitsQuestion(localIndex);
  });
  return { state, questions };
}

function noul(answer: NoulAnswer | ChoiceAnswer | undefined): number {
  return answer !== undefined && answer.type === "noul" && typeof answer.noul === "number" ? answer.noul : 0;
}

export async function run(
  model: DecisionModel,
  input: PickToolInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<PickToolOutput> {
  // zod cannot cross-check ids, so re-validate here — the server registers the
  // raw shape and this is the path the tool is actually called on.
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (candidate.id === NONE_KEY) {
      throw new PickInputError(`A candidate id may not be "${NONE_KEY}"; it is the reserved no-match option.`);
    }
    if (seen.has(candidate.id)) {
      throw new PickInputError(`Candidate ids must be unique; "${candidate.id}" appears more than once.`);
    }
    seen.add(candidate.id);
  }

  const thresholds = resolveThresholds(config.thresholds, input.thresholds);
  const entries: Entry[] = input.candidates.map((candidate, index) => ({
    id: candidate.id,
    text: candidate.text,
    index,
  }));

  const { state, questions } = buildRequest(entries, input.question, input.none_label);
  if (!fitsBudget(state, questions, DEFAULT_BUDGET_LIMITS)) {
    const estimate = estimateBudget(state, questions);
    throw new BudgetError(
      `These ${entries.length} candidates plus the question are ~${estimate.total_tokens} estimated tokens, ` +
        `over the ${DEFAULT_BUDGET_LIMITS.total}-token limit. jev_pick is one request and never chunked: ` +
        `shorten the candidate texts or pre-filter in code before picking.`,
      "total",
      DEFAULT_BUDGET_LIMITS,
      estimate,
    );
  }

  const request: EvaluateRequest = { state, questions };
  if (signal !== undefined) request.signal = signal;
  const result = await model.evaluate(request);
  const answers = result.answers as Record<string, ChoiceAnswer | NoulAnswer | undefined>;

  const pickAnswer = answers.pick;
  const chosen = isChoice(pickAnswer) ? pickAnswer.choice : NONE_KEY;
  const confidence = isChoice(pickAnswer) && typeof pickAnswer.confidence === "number" ? pickAnswer.confidence : 0;

  // Map the winning index back to the caller's id; `none`, or any answer that
  // is not a valid index, reads as no pick.
  let pick: string | null = null;
  if (chosen !== NONE_KEY) {
    const index = Number(chosen);
    pick = Number.isInteger(index) && index >= 0 && index < entries.length ? (entries[index] as Entry).id : null;
  }

  // Probabilities and fits, mapped from index keys back to caller ids.
  const rawProbabilities = isChoice(pickAnswer) ? pickAnswer.probabilities : {};
  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawProbabilities)) {
    if (key === NONE_KEY) {
      probabilities[NONE_KEY] = value;
      continue;
    }
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index < entries.length) {
      probabilities[(entries[index] as Entry).id] = value;
    }
  }

  const fits: Record<string, number> = {};
  entries.forEach((entry, localIndex) => {
    fits[entry.id] = noul(answers[`fits_${localIndex}`]);
  });

  const output: PickToolOutput = {
    pick,
    confidence,
    probabilities,
    fits,
    gate: isChoice(pickAnswer) ? gateChoice(pickAnswer, thresholds) : "escalate",
    model: result.model,
    usage: result.usage,
    latency_ms: result.latency_ms,
  };
  return output;
}
