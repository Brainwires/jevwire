/**
 * `jev_rank` — relevance-rank candidate texts, or the caller's own files,
 * against a query.
 *
 * Order comes from a `which` Choice over each batch, reconciled across batches
 * by one final Choice over the batch winners; a calibrated yes/no per candidate
 * gives the absolute `relevance` that `min_relevance` filters on. The model
 * never sees candidate ids: ids are arbitrary caller strings and would be both a
 * distractor in the state and unsafe as question keys, so candidates go in as an
 * index-keyed array and the indices are mapped back to ids in code.
 *
 * With `paths` or `glob` the server does the reading. That is the whole point
 * of those two arguments: the caller spends no context emitting file text and
 * none ingesting the chunks that turned out to be irrelevant. What comes back
 * is `path:start-end` plus a score, so a 400-file search costs the caller a few
 * hundred tokens of output. File text is never echoed back, in either mode.
 */

import { z } from "zod";
import { BudgetError, DEFAULT_BUDGET_LIMITS, estimateBudget, fitsBudget, type BudgetLimits } from "../decision/budget.js";
import { estimateCostUsd } from "../decision/pricing.js";
import type {
  ChoiceAnswer,
  DecisionModel,
  EvaluateRequest,
  Json,
  NoulAnswer,
  Question,
  State,
} from "../decision/types.js";
import {
  collectChunks,
  emptySkipped,
  enforceSelection,
  FileSelectionError,
  type FileAccessOptions,
  type SkippedCounts,
} from "../files/index.js";
import { envelopeShape, mapWithConcurrency, sumUsage, type ToolConfig } from "./shared.js";
import { indexKeyedState, isChoice, type Entry } from "./candidates.js";

export const name = "jev_rank";

export const description = [
  "Rank files or texts by how well each helps answer a query: a relative Choice over the batch for order, Jev's calibrated yes/no per item for filtering.",
  "Pass `glob` or `paths` for anything you have not already read — do NOT read files to pass their text. The server reads and chunks them and returns only `path:start_line-end_line` + score, so a 300-file search costs almost no context either way.",
  "Pass `candidates` (id + text) only for text you already hold: search hits, retrieved passages, tool results.",
  "`unit`: `chunk` (default) ranks line ranges, `file` ranks whole files by their best chunk. Prefer `file` for 'where is X': a header comment can outrank the code it describes.",
  "Sensitive files (.env, keys, credentials), binaries and generated output are never read; they come back in `skipped`.",
  "Order comes from a Choice among the strongest candidates: trust the top 1-3 when `choice_margin` >= 0.10, the tail is by `relevance`. `relevance` is P(helps answer the query) and drives `min_relevance`; low `any_relevant` means look elsewhere.",
  "`score_spread` (top minus median relevance) below 0.15 means the absolute scores are flat; `choice_margin` says whether the top pick was clear.",
].join("\n");

const candidateSchema = z.object({
  id: z.string().min(1).describe("Your identifier for this candidate. Returned as-is; never shown to the model."),
  text: z.string().describe("The candidate text to judge. Keep it to the part that could answer the query."),
});

export const UNITS = ["chunk", "file"] as const;
export type RankUnit = (typeof UNITS)[number];

export const inputShape = {
  query: z.string().min(1).describe("What you are trying to find out."),
  candidates: z
    .array(candidateSchema)
    .min(1)
    .max(500)
    .optional()
    .describe("Text you already hold, 1 to 500. Use this only when you did not have to read a file to get it."),
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(1000)
    .optional()
    .describe("Files for the server to read, relative to the project root (absolute paths inside it are fine)."),
  glob: z
    .string()
    .min(1)
    .optional()
    .describe('A glob for the server to expand and read, e.g. "src/**/*.ts". Supports * ** ? [abc] {a,b}.'),
  unit: z
    .enum(UNITS)
    .optional()
    .describe("For paths/glob: `chunk` (default) ranks line ranges, `file` ranks whole files by their best chunk."),
  top_k: z.number().int().min(1).max(500).optional().describe("How many ranked results to return. Default 10."),
  min_relevance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Drop candidates whose relevance is below this. Default 0 (keep everything)."),
  instructions: z
    .string()
    .optional()
    .describe("Optional extra definition of what counts as relevant here, folded into every question."),
} as const;

/** Exactly one source. Two sources is a caller bug, not something to merge. */
export const inputSchema = z.object(inputShape).refine(
  (value) => [value.candidates, value.paths, value.glob].filter((v) => v !== undefined).length === 1,
  {
    message:
      "Pass exactly one of `candidates`, `paths` or `glob`. Use `glob`/`paths` for files you have not read " +
      "(the server reads them), and `candidates` only for text you already hold.",
  },
);
export type RankToolInput = z.infer<typeof inputSchema>;

const skippedSchema = z
  .object({
    binary: z.number().int(),
    too_large: z.number().int(),
    sensitive: z.number().int().describe("Files holding credentials. Never read, never sent, whatever named them."),
    outside_root: z.number().int().describe("Paths that resolved outside the project root, symlinks included."),
    not_found: z.number().int(),
    ignored: z.number().int().describe("Lockfiles, `*.min.*`, sourcemaps and ignored directories."),
  })
  .describe("Why files were not read. Nothing is dropped silently.");

export const outputShape = {
  ranked: z
    .array(
      z.object({
        id: z.string().optional().describe("Present for `candidates` sources: your own id, as passed."),
        path: z.string().optional().describe("Present for file sources: path relative to the project root."),
        start_line: z.number().int().optional().describe("1-based, inclusive."),
        end_line: z.number().int().optional().describe("1-based, inclusive."),
        relevance: z.number().describe("P(this item helps answer the query), 0..1. Absolute; what `min_relevance` filters on."),
        rank: z.number().int().describe("1-based position after sorting and filtering."),
        choice: z
          .number()
          .describe("The Choice probability from the request that placed this row (the final round for the top items, its own batch for the tail)."),
      }),
    )
    .describe("Ordered by the Choice among the strongest candidates, then by relevance for the tail. Text is never echoed back."),
  any_relevant: z
    .number()
    .describe(
      "P(at least one candidate helps answer the query), judged once over the strongest candidates. Low means: look elsewhere.",
    ),
  choice_margin: z
    .number()
    .describe(
      "Top pick's Choice probability minus the runner-up's, in the request that decided the order, 2 decimals. " +
        "Below 0.10 the top pick and the runner-up were a toss-up; open both.",
    ),
  score_spread: z
    .number()
    .describe(
      "Top relevance minus median relevance, 2 decimals. How much the ranking actually discriminated. " +
        "Below 0.15 the scores are effectively flat and the ordering is not informative: narrow the glob or " +
        "rephrase the query rather than trusting the order.",
    ),
  chunks: z.number().int().describe("How many API requests this took: the fan-out over the batches plus the final deciding request."),
  total_candidates: z.number().int().describe("How many items were judged, before top_k/min_relevance."),
  files_scanned: z.number().int().optional().describe("File sources only: files actually read."),
  chunks_scored: z.number().int().optional().describe("File sources only: line-range chunks judged."),
  skipped: skippedSchema.optional().describe("File sources only."),
  est_cost_usd: z.number().optional().describe("File sources only: estimated input-token cost of this call."),
  ...envelopeShape,
} as const;

export const outputSchema = z.object(outputShape);
export type RankToolOutput = z.infer<typeof outputSchema>;

const ANY_RELEVANT_ID = "any_relevant";
const DEFAULT_TOP_K = 10;
/** Default fan-out for file sources; `JEV_MAX_CONCURRENCY` overrides it. */
export const FILE_CONCURRENCY = 8;

/**
 * Most candidates per request, whatever the source.
 *
 * Order no longer comes from the per-candidate Noul — which went flat past ~50
 * candidates a request — but from a `which` Choice over the batch, then a final
 * Choice over the batch winners. A Choice discriminates across a wider set than
 * a Noul battery does, so the cap is raised toward the Choice's reliable width
 * (~240 options). The context budget still binds first: file chunks average
 * ~2.3k chars, so a request fills at ~45 chunks regardless of this cap, and 200
 * is reached only by short candidates (grep hits, symbol lists) — which is also
 * `jev_pick`'s regime. `scripts/bench-rank.ts` is what sets this number.
 */
export const MAX_CANDIDATES_PER_REQUEST = 200;

/** Top candidates each batch contributes to the final deciding request. */
export const FINALISTS_PER_REQUEST = 3;

export type { Entry };

function candidateQuestion(localIndex: number, extra: string | undefined): Question {
  const suffix = extra === undefined || extra.trim() === "" ? "" : ` Relevant here means: ${extra.trim()}`;
  return {
    type: "noul",
    instructions:
      `Does \`candidates[${localIndex}]\` contain information that helps answer \`query\`?${suffix}`,
    criteria: {
      true: `The text in \`candidates[${localIndex}]\` states something that helps answer \`query\`, even if it is only part of the answer.`,
      false: `The text in \`candidates[${localIndex}]\` is about something else, or is too generic to help answer \`query\`.`,
    },
  };
}

function anyRelevantQuestion(extra: string | undefined): Question {
  const suffix = extra === undefined || extra.trim() === "" ? "" : ` Relevant here means: ${extra.trim()}`;
  return {
    type: "noul",
    instructions: `Does at least one entry in \`candidates\` contain information that helps answer \`query\`?${suffix}`,
    criteria: {
      true: "At least one entry states something that helps answer `query`.",
      false: "No entry helps answer `query`.",
    },
  };
}

const WHICH_ID = "which";

/**
 * The relative Choice: which single candidate best helps, over the batch.
 *
 * Option names are the zero-based indices into `candidates`; their values are
 * `null` because the text is already in the state and a label would only
 * duplicate it (and a 40-char chunk head is exactly the "header comment
 * outranks the code" distractor). `none` carries a real description so the
 * model has somewhere to put "nothing here helps".
 */
function whichQuestion(n: number, extra: string | undefined): Question {
  const suffix = extra === undefined || extra.trim() === "" ? "" : ` Relevant here means: ${extra.trim()}`;
  const criteria: Record<string, string | null> = {};
  for (let i = 0; i < n; i += 1) criteria[String(i)] = null;
  criteria.none = "No entry in `candidates` contains information that helps answer `query`.";
  return {
    type: "choice",
    instructions:
      "Which entry of `candidates` best helps answer `query`? The option names are the zero-based indices " +
      `into \`candidates\`. Choose \`none\` only if no entry helps at all.${suffix}`,
    criteria,
  };
}

function buildRequest(
  query: string,
  entries: readonly Entry[],
  extra: string | undefined,
  opts: { anyRelevant: boolean },
): { state: State; questions: Record<string, Question> } {
  const state: Record<string, Json> = { query, candidates: indexKeyedState(entries) };
  const questions: Record<string, Question> = {};
  entries.forEach((_entry, localIndex) => {
    questions[`cand_${localIndex}`] = candidateQuestion(localIndex, extra);
  });
  questions[WHICH_ID] = whichQuestion(entries.length, extra);
  // Asked only in the request that decides the order — the single request, or
  // the final one over the batch winners — never redundantly in every batch.
  if (opts.anyRelevant) questions[ANY_RELEVANT_ID] = anyRelevantQuestion(extra);
  return { state, questions };
}

/**
 * Greedily pack candidates into chunks, bounded by two things: the context
 * budget, and `MAX_CANDIDATES_PER_REQUEST`. Whichever binds first wins.
 *
 * Every chunk carries the query and only its own candidates, so the per-chunk
 * state stays small — which is also what the model wants, and the count cap is
 * there because the budget alone is far too generous to keep it that way.
 */
export function chunkCandidates(
  query: string,
  entries: readonly Entry[],
  extra: string | undefined,
  limits: BudgetLimits = DEFAULT_BUDGET_LIMITS,
  maxPerRequest: number = MAX_CANDIDATES_PER_REQUEST,
): Entry[][] {
  const chunks: Entry[][] = [];
  let current: Entry[] = [];

  for (const entry of entries) {
    if (current.length >= maxPerRequest) {
      chunks.push(current);
      current = [];
    }
    const solo = buildRequest(query, [entry], extra, { anyRelevant: true });
    if (!fitsBudget(solo.state, solo.questions, limits)) {
      const estimate = estimateBudget(solo.state, solo.questions);
      throw new BudgetError(
        `Candidate "${entry.id}" is too large to rank on its own: the query plus that one candidate is ` +
          `~${estimate.total_tokens} estimated tokens, over the ${limits.total}-token limit. ` +
          `Shorten or split that candidate's text before ranking.`,
        "total",
        limits,
        estimate,
      );
    }

    const attempt = [...current, entry];
    const request = buildRequest(query, attempt, extra, { anyRelevant: true });
    if (fitsBudget(request.state, request.questions, limits)) {
      current = attempt;
    } else {
      chunks.push(current);
      current = [entry];
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

interface Source {
  entries: Entry[];
  /** Absent for `candidates`, so that output stays byte-identical to 0.1.x. */
  files?:
    | { files_scanned: number; chunks_scored: number; skipped: SkippedCounts; est_cost_usd: number }
    | undefined;
  fromFiles: boolean;
}

/**
 * Exactly one source, checked here as well as in the zod refine.
 *
 * The MCP server registers `inputShape`, the raw shape, so the refine on
 * `inputSchema` only runs for callers who parse it themselves. A cross-field
 * rule that is not enforced on the path the tool is actually called on is not
 * enforced at all.
 */
export function validateSource(input: Pick<RankToolInput, "candidates" | "paths" | "glob" | "unit">): void {
  const named = (["candidates", "paths", "glob"] as const).filter((key) => input[key] !== undefined);
  if (named.length !== 1) {
    throw new FileSelectionError(
      "bad_source",
      named.length === 0
        ? "Pass exactly one of `candidates`, `paths` or `glob`. Use `glob` or `paths` for files you have not " +
          "read — the server reads them — and `candidates` only for text you already hold."
        : `Pass exactly one of \`candidates\`, \`paths\` or \`glob\`; got ${named.join(" and ")}.`,
    );
  }
  if (input.unit !== undefined && input.candidates !== undefined) {
    throw new FileSelectionError(
      "bad_source",
      "`unit` applies to `paths`/`glob` only: a `candidates` entry is already the unit you chose.",
    );
  }
}

/** Build the entry list from whichever source the caller passed. */
function buildSource(input: RankToolInput, fileOptions: FileAccessOptions): Source {
  validateSource(input);
  if (input.candidates !== undefined) {
    return {
      entries: input.candidates.map((candidate, index) => ({ id: candidate.id, text: candidate.text, index })),
      fromFiles: false,
    };
  }

  const selection =
    input.glob !== undefined
      ? collectChunks({ glob: input.glob }, fileOptions)
      : collectChunks({ paths: input.paths ?? [] }, fileOptions);
  // Priced and refused here, before a single request goes out.
  enforceSelection(selection, fileOptions);

  const entries: Entry[] = selection.chunks.map((chunk, index) => ({
    id: `${chunk.path}:${chunk.start_line}-${chunk.end_line}`,
    text: chunk.text,
    index,
    where: { path: chunk.path, start_line: chunk.start_line, end_line: chunk.end_line },
  }));

  return {
    entries,
    files: {
      files_scanned: selection.files_scanned,
      chunks_scored: selection.chunks.length,
      skipped: selection.skipped,
      est_cost_usd: selection.est_cost_usd,
    },
    fromFiles: true,
  };
}

interface Scored {
  entry: Entry;
  relevance: number;
}

/**
 * How much the scores actually spread: top minus median, 2 decimals.
 *
 * The honest diagnostic for whether a ranking means anything. A run whose
 * candidates all score 0.84 to 0.87 has a spread near zero and an ordering that
 * is noise, however confident the top number looks. Pure.
 */
export function scoreSpread(relevances: readonly number[]): number {
  if (relevances.length === 0) return 0;
  const sorted = [...relevances].sort((a, b) => b - a);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  return Math.round(((sorted[0] as number) - median) * 100) / 100;
}

/** Below this, the ordering is not informative. Quoted in the tool description. */
export const UNINFORMATIVE_SPREAD = 0.15;

/** One row per file, scored by its best chunk, keeping that chunk's range. */
export function foldToFiles(scored: readonly Scored[]): Scored[] {
  const best = new Map<string, Scored>();
  for (const item of scored) {
    const path = item.entry.where?.path;
    if (path === undefined) continue;
    const current = best.get(path);
    if (current === undefined || item.relevance > current.relevance) best.set(path, item);
  }
  return [...best.values()];
}

/** A candidate placed in the order, with the Choice probability that placed it. */
export interface Placed {
  entry: Entry;
  relevance: number;
  choice: number;
}

/**
 * Top pick's probability minus the runner-up's, over the option probabilities
 * of the deciding request, `none` excluded. 2 decimals. Below 0.10 the top two
 * were a toss-up.
 */
export function choiceMargin(probabilities: Record<string, number>): number {
  const values = Object.entries(probabilities)
    .filter(([key]) => key !== "none")
    .map(([, value]) => value)
    .sort((a, b) => b - a);
  if (values.length === 0) return 0;
  const top = values[0] as number;
  const runner = values[1] ?? 0;
  return Math.round((top - runner) * 100) / 100;
}

/**
 * The candidates that go into the final deciding request: the top
 * `FINALISTS_PER_REQUEST` of each batch by its own `which`, then trimmed by
 * descending relevance until one request over them all fits the budget.
 *
 * Pure: takes each batch's scored candidates, returns the finalist entries in
 * no particular order (the final request decides the order among them).
 */
export function pickFinalists(
  perRequest: readonly { scores: readonly Placed[] }[],
  query: string,
  extra: string | undefined,
  limits: BudgetLimits = DEFAULT_BUDGET_LIMITS,
): Entry[] {
  const pool: Placed[] = [];
  for (const request of perRequest) {
    const top = [...request.scores].sort((a, b) => b.choice - a.choice).slice(0, FINALISTS_PER_REQUEST);
    pool.push(...top);
  }
  pool.sort((a, b) => b.relevance - a.relevance || a.entry.index - b.entry.index);
  let finalists = pool.map((item) => item.entry);
  while (finalists.length > 1) {
    const request = buildRequest(query, finalists, extra, { anyRelevant: true });
    if (fitsBudget(request.state, request.questions, limits)) break;
    finalists = finalists.slice(0, -1);
  }
  return finalists;
}

/**
 * The global order: finalists first, by the deciding request's `which` (ties by
 * relevance, then input index); then every non-finalist by relevance, index.
 * The finalists' `choice` is overwritten with the deciding request's value.
 * Pure.
 */
export function orderRows(
  all: readonly Placed[],
  finalists: ReadonlySet<Entry>,
  finalChoice: ReadonlyMap<Entry, number>,
): Placed[] {
  const finalistRows = all
    .filter((row) => finalists.has(row.entry))
    .map((row) => ({ ...row, choice: finalChoice.get(row.entry) ?? row.choice }))
    .sort((a, b) => b.choice - a.choice || b.relevance - a.relevance || a.entry.index - b.entry.index);
  const tailRows = all
    .filter((row) => !finalists.has(row.entry))
    .sort((a, b) => b.relevance - a.relevance || a.entry.index - b.entry.index);
  return [...finalistRows, ...tailRows];
}

/** Fold to one row per file keeping its best-ranked chunk: first occurrence in an already-ordered list. */
export function foldToFilesByRank(ordered: readonly Placed[]): Placed[] {
  const seen = new Set<string>();
  const out: Placed[] = [];
  for (const row of ordered) {
    const path = row.entry.where?.path;
    if (path === undefined) {
      out.push(row);
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(row);
  }
  return out;
}

/** The Noul value of an answer, or 0 when it is absent or not a Noul. */
function noulOf(answer: NoulAnswer | ChoiceAnswer | undefined): number {
  return answer !== undefined && answer.type === "noul" && typeof answer.noul === "number" ? answer.noul : 0;
}

export async function run(
  model: DecisionModel,
  input: RankToolInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<RankToolOutput> {
  const fileOptions: FileAccessOptions = config.files ?? {};
  const source = buildSource(input, fileOptions);
  const entries = source.entries;

  const chunks = chunkCandidates(input.query, entries, input.instructions);
  // File sources fan out wider by default: the work is one request per batch of
  // chunks, and a 400-file glob is otherwise serialised four at a time.
  const concurrency =
    source.fromFiles && config.maxConcurrencyExplicit !== true
      ? Math.max(config.maxConcurrency, FILE_CONCURRENCY)
      : config.maxConcurrency;
  const started = Date.now();
  const single = chunks.length === 1;

  const perRequest = await mapWithConcurrency(chunks, concurrency, async (chunk) => {
    const { state, questions } = buildRequest(input.query, chunk, input.instructions, { anyRelevant: single });
    const request: EvaluateRequest = { state, questions };
    if (signal !== undefined) request.signal = signal;
    const result = await model.evaluate(request);
    const answers = result.answers as Record<string, NoulAnswer | ChoiceAnswer | undefined>;
    const whichAnswer = answers[WHICH_ID];
    const which = isChoice(whichAnswer) ? whichAnswer.probabilities : {};
    const scores: Placed[] = chunk.map((entry, localIndex) => ({
      entry,
      relevance: noulOf(answers[`cand_${localIndex}`]),
      choice: which[String(localIndex)] ?? 0,
    }));
    const anyRelevant = single ? noulOf(answers[ANY_RELEVANT_ID]) : undefined;
    return { scores, which, anyRelevant, result };
  });

  const flat: Placed[] = perRequest.flatMap((request) => request.scores);
  const usageParts = perRequest.map((request) => request.result.usage);
  const answeringModel = perRequest[0]?.result.model ?? model.name;

  let finalists: ReadonlySet<Entry>;
  let finalChoice: ReadonlyMap<Entry, number>;
  let anyRelevant: number;
  let choiceMarginValue: number;
  let requestCount = chunks.length;

  if (single) {
    const only = perRequest[0];
    finalists = new Set((only?.scores ?? []).map((score) => score.entry));
    finalChoice = new Map((only?.scores ?? []).map((score) => [score.entry, score.choice]));
    anyRelevant = only?.anyRelevant ?? 0;
    choiceMarginValue = choiceMargin(only?.which ?? {});
  } else {
    const chosen = pickFinalists(perRequest, input.query, input.instructions);
    const { state, questions } = buildRequest(input.query, chosen, input.instructions, { anyRelevant: true });
    const finalRequest: EvaluateRequest = { state, questions };
    if (signal !== undefined) finalRequest.signal = signal;
    const finalResult = await model.evaluate(finalRequest);
    requestCount += 1;
    usageParts.push(finalResult.usage);
    const finalAnswers = finalResult.answers as Record<string, NoulAnswer | ChoiceAnswer | undefined>;
    const finalWhichAnswer = finalAnswers[WHICH_ID];
    const finalWhich = isChoice(finalWhichAnswer) ? finalWhichAnswer.probabilities : {};
    finalists = new Set(chosen);
    finalChoice = new Map(chosen.map((entry, localIndex) => [entry, finalWhich[String(localIndex)] ?? 0]));
    anyRelevant = noulOf(finalAnswers[ANY_RELEVANT_ID]);
    choiceMarginValue = choiceMargin(finalWhich);
  }

  const unit: RankUnit = input.unit ?? "chunk";
  const ordered = orderRows(flat, finalists, finalChoice);
  const rows = source.fromFiles && unit === "file" ? foldToFilesByRank(ordered) : ordered;

  const minRelevance = input.min_relevance ?? 0;
  const topK = input.top_k ?? DEFAULT_TOP_K;

  const ranked = rows
    .filter((item) => item.relevance >= minRelevance)
    .slice(0, topK)
    .map((item, position) => {
      const row: RankToolOutput["ranked"][number] = {
        relevance: item.relevance,
        rank: position + 1,
        choice: Math.round(item.choice * 100) / 100,
      };
      if (item.entry.where === undefined) {
        row.id = item.entry.id;
      } else {
        row.path = item.entry.where.path;
        row.start_line = item.entry.where.start_line;
        row.end_line = item.entry.where.end_line;
      }
      return row;
    });

  const output: RankToolOutput = {
    ranked,
    any_relevant: anyRelevant,
    choice_margin: choiceMarginValue,
    // Over everything judged, not just the rows that survived top_k: the
    // question it answers is whether the absolute scores discriminated at all.
    score_spread: scoreSpread(rows.map((row) => row.relevance)),
    chunks: requestCount,
    total_candidates: rows.length,
    model: answeringModel,
    usage: sumUsage(usageParts),
    latency_ms: Date.now() - started,
  };

  if (source.files !== undefined) {
    output.files_scanned = source.files.files_scanned;
    output.chunks_scored = source.files.chunks_scored;
    output.skipped = source.files.skipped;
    // The estimate is what the ceiling was enforced against; `usage` below is
    // what the API actually billed.
    output.est_cost_usd = source.files.est_cost_usd;
  }

  return output;
}

/** Re-exported for tests that build a selection without touching a model. */
export { emptySkipped, estimateCostUsd };
