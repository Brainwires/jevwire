/**
 * `jev_verify` — check claims against supplied evidence, and only that evidence.
 *
 * One Choice per claim over supported / contradicted / not_addressed. The whole
 * point of the rubric is the third option: without it the model is forced to
 * pick a side on a claim the evidence never mentions.
 *
 * `evidence_path` is the cheap way in. The caller names the file it wants its
 * draft held to and the server reads it, so the evidence never passes through
 * the caller's context on its way to being checked. Evidence too large for one
 * request is split, every claim is judged against every piece, and the pieces
 * are merged in code — because "which chunk was most sure" is arithmetic, and
 * arithmetic is not something to ask a classifier.
 */

import { z } from "zod";
import { DEFAULT_BUDGET_LIMITS, estimateTokens, fitsBudget, type BudgetLimits } from "../decision/budget.js";
import { gate, resolveThresholds } from "../decision/policy.js";
import { estimateCostUsd } from "../decision/pricing.js";
import type { ChoiceAnswer, DecisionModel, EvaluateRequest, Json, Question } from "../decision/types.js";
import {
  FileSelectionError,
  MAX_INPUT_TOKENS,
  readTextFile,
  resolveInsideRoot,
  rootOf,
  type FileAccessOptions,
} from "../files/index.js";
import { envelopeShape, gateSchema, mapWithConcurrency, sumUsage, thresholdsSchema, type ToolConfig } from "./shared.js";
import {
  allSupported,
  claimQuestion,
  EvidenceTooLongError,
  MERGED_VERDICTS,
  mergeClaim,
  packEvidence,
  questionId,
  runVerifyCore,
  VERDICTS,
  type ClaimResult,
  type EvidencePiece,
  type MergedVerdict,
  type Verdict,
  type VerifyCoreInput,
  type VerifyCoreResult,
} from "./verify-core.js";

// Re-exported so callers that imported these from the tool keep working.
export {
  allSupported,
  claimQuestion,
  EvidenceTooLongError,
  MERGED_VERDICTS,
  mergeClaim,
  packEvidence,
  questionId,
  runVerifyCore,
  VERDICTS,
};
export type { ClaimResult, EvidencePiece, MergedVerdict, Verdict, VerifyCoreInput, VerifyCoreResult };

export const name = "jev_verify";

export const description = [
  "Check up to 100 claims against one body of evidence: supported / contradicted / not_addressed per claim, with a calibrated confidence.",
  "Pass `evidence_path` for anything you have not already read — do NOT read a file in order to pass its text. The server reads it, chunks it if it is large, checks every claim against every chunk and returns line ranges. Use `evidence` only for text you already hold.",
  "Use it before you assert something to the user or write it into a file: hold your draft's claims to the source, or check a summary against the document it summarises.",
  "The rubric is strictly literal and closed-world: supported only if the evidence states or entails it. A claim that is true in the world but absent from the evidence comes back `not_addressed` — which is the answer you want when hunting unsupported assertions. `conflicting` means one part of the evidence firmly supports it and another firmly contradicts it.",
  "Claims should be single, self-contained statements — split compound sentences and resolve pronouns first.",
  "`all_supported` is true only when every claim is supported AND the model was confident about each; treat `review`/`escalate` gates as claims a human should look at.",
].join("\n");

export const inputShape = {
  claims: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .describe("Self-contained statements to check, one per entry. Split compound claims."),
  evidence: z.string().min(1).optional().describe("Text you already hold. The only material the claims are judged against."),
  evidence_path: z
    .string()
    .min(1)
    .optional()
    .describe("A file for the server to read, relative to the project root. Preferred over pasting file text."),
  start_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("With `evidence_path`: first line to use, 1-based inclusive. Default 1."),
  end_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("With `evidence_path`: last line to use, 1-based inclusive. Default end of file."),
  thresholds: thresholdsSchema,
} as const;

export const inputSchema = z.object(inputShape).refine(
  (value) => [value.evidence, value.evidence_path].filter((v) => v !== undefined).length === 1,
  {
    message:
      "Pass exactly one of `evidence` or `evidence_path`. Use `evidence_path` for a file you have not read " +
      "(the server reads it); `evidence` only for text you already hold.",
  },
);
export type VerifyToolInput = z.infer<typeof inputSchema>;

/** The rubric the model chooses from. */
const verdictSchema = z.enum(MERGED_VERDICTS);

export const outputShape = {
  claims: z
    .array(
      z.object({
        claim: z.string(),
        verdict: verdictSchema,
        probabilities: z.record(z.string(), z.number()),
        confidence: z.number(),
        gate: gateSchema,
        where: z
          .object({ start_line: z.number().int(), end_line: z.number().int() })
          .optional()
          .describe("Which lines of the evidence settled it. Present when the evidence came from a file or was chunked."),
      }),
    )
    .describe("One result per input claim, in input order."),
  summary: z
    .object({
      supported: z.number().int(),
      contradicted: z.number().int(),
      not_addressed: z.number().int(),
      conflicting: z.number().int().describe("Firmly supported by one part of the evidence and contradicted by another."),
      needs_review: z.number().int().describe("Claims whose gate is not `auto`."),
    })
    .describe("Counts across all claims."),
  all_supported: z
    .boolean()
    .describe("True only if every claim is `supported` and every gate is `auto`."),
  thresholds: z.object({ auto: z.number(), review: z.number() }),
  evidence_chunks: z.number().int().describe("How many requests the evidence was split into. 1 unless it was large."),
  evidence_path: z.string().optional().describe("Present when the evidence was read from a file; relative to the root."),
  est_cost_usd: z.number().optional().describe("Present for file evidence: estimated input-token cost of this call."),
  ...envelopeShape,
} as const;

export const outputSchema = z.object(outputShape);
export type VerifyToolOutput = z.infer<typeof outputSchema>;

/**
 * Exactly one evidence source, checked here as well as in the zod refine: the
 * MCP server registers the raw shape, so the refine does not run on that path.
 */
export function validateSource(
  input: Pick<VerifyToolInput, "evidence" | "evidence_path" | "start_line" | "end_line">,
): void {
  const named = (["evidence", "evidence_path"] as const).filter((key) => input[key] !== undefined);
  if (named.length !== 1) {
    throw new FileSelectionError(
      "bad_source",
      named.length === 0
        ? "Pass exactly one of `evidence` or `evidence_path`. Use `evidence_path` for a file you have not read — " +
          "the server reads it — and `evidence` only for text you already hold."
        : "Pass exactly one of `evidence` or `evidence_path`; got both.",
    );
  }
  if (input.evidence !== undefined && (input.start_line !== undefined || input.end_line !== undefined)) {
    throw new FileSelectionError(
      "bad_source",
      "`start_line`/`end_line` select a window in `evidence_path`; they do not apply to inline `evidence`.",
    );
  }
}

/** Read `evidence_path`, honouring the line window and every refusal rule. */
function readEvidenceFile(input: VerifyToolInput, options: FileAccessOptions): { text: string; firstLine: number; path: string } {
  const root = rootOf(options);
  const named = input.evidence_path as string;
  const resolution = resolveInsideRoot(root, named);
  if (resolution.kind === "sensitive") {
    throw new FileSelectionError(
      "sensitive",
      `${named} holds credentials, so it is never read. Nothing was sent.`,
    );
  }
  if (resolution.kind === "outside_root") {
    throw new FileSelectionError(
      "outside_root",
      `${named} resolves outside the project root (${root}), so it is never read. Nothing was sent.`,
    );
  }
  if (resolution.kind === "not_found") {
    throw new FileSelectionError("not_found", `${named} is not a readable file under ${root}.`);
  }

  const read = readTextFile(resolution.absolute, options.maxFileBytes);
  if (read.kind === "binary") {
    throw new FileSelectionError("nothing_readable", `${resolution.relative} looks like a binary file.`);
  }
  if (read.kind === "too_large") {
    throw new FileSelectionError(
      "nothing_readable",
      `${resolution.relative} is over the size limit for one call. Use \`start_line\`/\`end_line\` to name a window.`,
    );
  }
  if (read.kind === "not_found") {
    throw new FileSelectionError("not_found", `${resolution.relative} could not be read.`);
  }

  const lines = read.text.split("\n");
  const first = Math.min(input.start_line ?? 1, lines.length);
  const last = Math.min(input.end_line ?? lines.length, lines.length);
  if (last < first) {
    throw new FileSelectionError(
      "bad_source",
      `end_line (${input.end_line}) is before start_line (${input.start_line}) in ${resolution.relative}.`,
    );
  }
  const text = lines.slice(first - 1, last).join("\n");
  if (text.trim() === "") {
    throw new FileSelectionError(
      "nothing_readable",
      `Lines ${first}-${last} of ${resolution.relative} contain no text to verify against.`,
    );
  }
  return { text, firstLine: first, path: resolution.relative };
}

export async function run(
  model: DecisionModel,
  input: VerifyToolInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<VerifyToolOutput> {
  validateSource(input);
  const thresholds = resolveThresholds(config.thresholds, input.thresholds);
  const fileOptions: FileAccessOptions = config.files ?? {};

  const fromFile = input.evidence_path !== undefined;
  const source = fromFile
    ? readEvidenceFile(input, fileOptions)
    : { text: input.evidence as string, firstLine: 1, path: undefined };

  let pieces;
  try {
    pieces = packEvidence(source.text, input.claims, source.firstLine);
  } catch (error) {
    if (error instanceof EvidenceTooLongError) throw new FileSelectionError("cost_ceiling", error.message);
    throw error;
  }

  // Priced before anything is sent: every piece carries every claim, so the
  // cost is the product, not the sum.
  const estimated = pieces.reduce(
    (sum, piece) => sum + estimateTokens(piece.text) + estimateTokens(input.claims) + 60 * input.claims.length,
    0,
  );
  const ceiling = fileOptions.maxInputTokens ?? MAX_INPUT_TOKENS;
  if (estimated > ceiling) {
    throw new FileSelectionError(
      "cost_ceiling",
      `Verifying ${input.claims.length} claims against ${pieces.length} pieces of this evidence would send an ` +
        `estimated ${estimated.toLocaleString("en-US")} input tokens (about $${estimateCostUsd(estimated).toFixed(2)}), ` +
        `over the ${ceiling.toLocaleString("en-US")}-token ceiling for one call. Nothing was sent. ` +
        `Narrow the evidence with \`start_line\`/\`end_line\`, or check fewer claims at once.`,
    );
  }

  const questions: Record<string, Question> = {};
  input.claims.forEach((_claim, index) => {
    questions[questionId(index)] = claimQuestion(index);
  });

  const started = Date.now();
  const results = await mapWithConcurrency(pieces, config.maxConcurrency, async (piece) => {
    const state: Record<string, Json> = { evidence: piece.text, claims: [...input.claims] };
    const request: EvaluateRequest = { state, questions };
    if (signal !== undefined) request.signal = signal;
    const result = await model.evaluate(request);
    return { piece, result };
  });

  // Report a line range whenever it means something: file evidence always, and
  // a chunked string because the caller can then see which part decided it.
  const reportWhere = fromFile || pieces.length > 1;

  const claims: ClaimResult[] = input.claims.map((claim, index) =>
    mergeClaim(
      claim,
      results.map(({ piece, result }) => ({
        piece,
        answer: (result.answers as Record<string, ChoiceAnswer | undefined>)[questionId(index)],
      })),
      thresholds,
      reportWhere,
    ),
  );

  const summary = {
    supported: claims.filter((c) => c.verdict === "supported").length,
    contradicted: claims.filter((c) => c.verdict === "contradicted").length,
    not_addressed: claims.filter((c) => c.verdict === "not_addressed").length,
    conflicting: claims.filter((c) => c.verdict === "conflicting").length,
    needs_review: claims.filter((c) => c.gate !== "auto").length,
  };

  const output: VerifyToolOutput = {
    claims,
    summary,
    all_supported: allSupported(claims),
    thresholds,
    evidence_chunks: pieces.length,
    model: results[0]?.result.model ?? model.name,
    usage: sumUsage(results.map(({ result }) => result.usage)),
    latency_ms: Date.now() - started,
  };
  if (source.path !== undefined) {
    output.evidence_path = source.path;
    output.est_cost_usd = estimateCostUsd(estimated);
  }
  return output;
}

/** Re-exported so callers can gate a merged confidence the same way. */
export { gate };
