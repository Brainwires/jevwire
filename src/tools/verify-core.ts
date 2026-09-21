/**
 * The zod-free, file-layer-free core of `jev_verify`: the rubric, the evidence
 * packer, the cross-piece merge, and a `runVerifyCore` that a hook can call.
 *
 * Split out the way `gate-action-core.ts` is split from `gate-action.ts`: the
 * MCP tool (`verify.ts`) keeps the zod schemas, the file reader and the public
 * `run`; everything a Stop hook needs to check the final message's claims
 * against `git diff HEAD` lives here, so `hook.mjs` never pulls in zod or
 * `src/files/`.
 */

import { DEFAULT_BUDGET_LIMITS, fitsBudget, type BudgetLimits } from "../decision/budget.js";
import { gateChoice } from "../decision/policy.js";
import type {
  ChoiceAnswer,
  DecisionModel,
  EvaluateRequest,
  Gate,
  GateThresholds,
  Json,
  Question,
} from "../decision/types.js";
import { mapWithConcurrency, sumUsage } from "../util/concurrency.js";

export const VERDICTS = ["supported", "contradicted", "not_addressed"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** What a merge across chunks can conclude, which the rubric alone cannot. */
export const MERGED_VERDICTS = [...VERDICTS, "conflicting"] as const;
export type MergedVerdict = (typeof MERGED_VERDICTS)[number];

/**
 * The rubric. Written so each option says what must be *present in the
 * evidence*, because Jev reads the instructions literally and will otherwise
 * fall back on world knowledge.
 */
export const CRITERIA: Record<Verdict, string> = {
  supported:
    "`evidence` explicitly states the claim, or states something that directly entails it. " +
    "Outside knowledge does not count, no matter how obviously true the claim is.",
  contradicted: "`evidence` explicitly states something that cannot be true at the same time as the claim.",
  not_addressed:
    "`evidence` says nothing that settles the claim either way. Choose this when the claim is merely " +
    "plausible, when it is true in the world but not stated in `evidence`, or when `evidence` only " +
    "touches a related but different point.",
};

export function claimQuestion(index: number): Question {
  return {
    type: "choice",
    instructions: `Considering only the text in \`evidence\`, how does \`evidence\` treat the statement in \`claims[${index}]\`?`,
    criteria: { ...CRITERIA },
  };
}

export function questionId(index: number): string {
  return `claim_${index}`;
}

export interface ClaimResult {
  claim: string;
  verdict: MergedVerdict;
  probabilities: Record<string, number>;
  confidence: number;
  gate: Gate;
  where?: { start_line: number; end_line: number } | undefined;
}

/** `all_supported` demands both the verdict and the certainty. Pure. */
export function allSupported(results: readonly ClaimResult[]): boolean {
  return results.length > 0 && results.every((r) => r.verdict === "supported" && r.gate === "auto");
}

export function normalizeVerdict(choice: string): Verdict {
  return (VERDICTS as readonly string[]).includes(choice) ? (choice as Verdict) : "not_addressed";
}

// ------------------------------------------------------------ evidence pieces

export interface EvidencePiece {
  text: string;
  /** 1-based inclusive, in the coordinates of the original file or string. */
  start_line: number;
  end_line: number;
}

/** Lines shared by two neighbouring pieces, so a split cannot hide support. */
const PIECE_OVERLAP_LINES = 5;

/** Thrown when a single evidence line cannot be verified against the claims on its own. */
export class EvidenceTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceTooLongError";
  }
}

/**
 * Split evidence into pieces that each fit one request alongside every claim.
 *
 * Greedy and line-based: lines are added until the next one would not fit, then
 * a new piece starts a few lines back. A single line that does not fit on its
 * own is a request the caller has to narrow, and says so.
 */
export function packEvidence(
  text: string,
  claims: readonly string[],
  firstLine = 1,
  limits: BudgetLimits = DEFAULT_BUDGET_LIMITS,
): EvidencePiece[] {
  const questions: Record<string, Question> = {};
  claims.forEach((_claim, index) => {
    questions[questionId(index)] = claimQuestion(index);
  });
  const fits = (body: string): boolean =>
    fitsBudget({ evidence: body, claims: [...claims] } as unknown as Record<string, Json>, questions, limits);

  if (fits(text)) {
    const lineCount = text.split("\n").length;
    return [{ text, start_line: firstLine, end_line: firstLine + lineCount - 1 }];
  }

  const lines = text.split("\n");
  const pieces: EvidencePiece[] = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let accepted = "";
    while (end < lines.length) {
      const attempt = lines.slice(start, end + 1).join("\n");
      if (!fits(attempt)) break;
      accepted = attempt;
      end += 1;
    }

    if (end === start) {
      throw new EvidenceTooLongError(
        `Line ${firstLine + start} of the evidence is too long to verify on its own against ` +
          `${claims.length} claim${claims.length === 1 ? "" : "s"}. Pass fewer claims, or narrow the evidence ` +
          `with \`start_line\`/\`end_line\`.`,
      );
    }

    pieces.push({ text: accepted, start_line: firstLine + start, end_line: firstLine + end - 1 });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - PIECE_OVERLAP_LINES);
  }

  return pieces;
}

export interface PieceAnswer {
  piece: EvidencePiece;
  answer: ChoiceAnswer | undefined;
}

/**
 * Merge one claim's verdicts across evidence pieces.
 *
 * The rule, in order:
 *  - a piece that firmly supports and a piece that firmly contradicts means
 *    the evidence disagrees with itself: `conflicting`, and never automatic;
 *  - otherwise the piece that was most sure of *something* wins, measured as
 *    max(supported, contradicted), because `not_addressed` is the answer every
 *    piece gives about the parts of the document it does not contain;
 *  - `not_addressed` survives only if every piece said it.
 */
export function mergeClaim(
  claim: string,
  answers: readonly PieceAnswer[],
  thresholds: GateThresholds,
  reportWhere: boolean,
): ClaimResult {
  const present = answers.filter((a): a is { piece: EvidencePiece; answer: ChoiceAnswer } => a.answer !== undefined);
  if (present.length === 0) {
    return { claim, verdict: "not_addressed", probabilities: {}, confidence: 0, gate: "escalate" };
  }

  const decisiveness = (a: ChoiceAnswer): number =>
    Math.max(a.probabilities.supported ?? 0, a.probabilities.contradicted ?? 0);

  const firmlySupports = present.some(
    (a) => normalizeVerdict(a.answer.choice) === "supported" && (a.answer.probabilities.supported ?? 0) >= thresholds.auto,
  );
  const firmlyContradicts = present.some(
    (a) =>
      normalizeVerdict(a.answer.choice) === "contradicted" && (a.answer.probabilities.contradicted ?? 0) >= thresholds.auto,
  );

  const best = present.reduce((a, b) => (decisiveness(b.answer) > decisiveness(a.answer) ? b : a));

  if (firmlySupports && firmlyContradicts) {
    const result: ClaimResult = {
      claim,
      verdict: "conflicting",
      probabilities: best.answer.probabilities,
      confidence: best.answer.confidence,
      gate: "escalate",
    };
    if (reportWhere) result.where = { start_line: best.piece.start_line, end_line: best.piece.end_line };
    return result;
  }

  const result: ClaimResult = {
    claim,
    verdict: normalizeVerdict(best.answer.choice),
    probabilities: best.answer.probabilities,
    confidence: best.answer.confidence,
    gate: gateChoice(best.answer, thresholds),
  };
  if (reportWhere) result.where = { start_line: best.piece.start_line, end_line: best.piece.end_line };
  return result;
}

// ----------------------------------------------------------------- the runner

export interface VerifyCoreInput {
  claims: readonly string[];
  evidence: string;
  /** Line the evidence starts at in its original coordinates. */
  firstLine?: number | undefined;
  thresholds: GateThresholds;
  /** Cap on evidence pieces (time budget). Extra pieces are dropped, flagged `truncated`. */
  maxPieces?: number | undefined;
}

export interface VerifyCoreResult {
  claims: ClaimResult[];
  pieces: number;
  /** True when `maxPieces` dropped some of the evidence. */
  truncated: boolean;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  latency_ms: number;
  memo?: boolean;
}

/**
 * Verify claims against a block of evidence the caller already assembled.
 *
 * The hook path: the Stop handler builds `evidence` from `git diff HEAD`, hands
 * it here with the extracted change sentences as `claims`, and reads back the
 * merged verdicts. No zod, no file reading, no pricing ceiling — the caller
 * owns the evidence size.
 */
export async function runVerifyCore(
  model: DecisionModel,
  input: VerifyCoreInput,
  config: { maxConcurrency: number },
  signal?: AbortSignal,
): Promise<VerifyCoreResult> {
  const firstLine = input.firstLine ?? 1;
  let pieces = packEvidence(input.evidence, input.claims, firstLine);
  let truncated = false;
  if (input.maxPieces !== undefined && pieces.length > input.maxPieces) {
    pieces = pieces.slice(0, input.maxPieces);
    truncated = true;
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

  const reportWhere = pieces.length > 1;
  const claims = input.claims.map((claim, index) =>
    mergeClaim(
      claim,
      results.map(({ piece, result }) => ({
        piece,
        answer: (result.answers as Record<string, ChoiceAnswer | undefined>)[questionId(index)],
      })),
      input.thresholds,
      reportWhere,
    ),
  );

  const memo = results.length > 0 && results.every(({ result }) => result.memo === true);
  return {
    claims,
    pieces: pieces.length,
    truncated,
    usage: sumUsage(results.map(({ result }) => result.usage)),
    model: results[0]?.result.model ?? model.name,
    latency_ms: Date.now() - started,
    ...(memo ? { memo: true } : {}),
  };
}
