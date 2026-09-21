/**
 * Public library entry.
 *
 * MCP is one way to reach the decision layer; embedding it directly is the
 * other, and for mandatory checks the better one. Import `JevDecisionModel`
 * plus the `run*` functions and call them at your harness's boundaries — a
 * check an agent can decline to call is not a check.
 */

// The contract.
export type {
  Answer,
  AnswerFor,
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionModel,
  EvaluateRequest,
  EvaluateResult,
  Gate,
  GateThresholds,
  Instructions,
  Json,
  NoulAnswer,
  NoulQuestion,
  Question,
  ScoreAnswer,
  ScoreQuestion,
  State,
  Usage,
} from "./decision/types.js";
export type { ListModelsResult, ModelCatalog, ModelInfo } from "./decision/models.js";
export { isModelCatalog } from "./decision/models.js";

// Policy, budget, validation.
export {
  DEFAULT_THRESHOLDS,
  gate,
  gateChoice,
  gateNoul,
  gateScore,
  isUncertain,
  lean,
  resolveThresholds,
  type Lean,
  type NoulDirection,
  type NoulGate,
} from "./decision/policy.js";
export {
  BudgetError,
  CHARS_PER_TOKEN,
  checkBudget,
  DEFAULT_BUDGET_LIMITS,
  estimateBudget,
  estimateQuestionTokens,
  estimateTokens,
  fitsBudget,
  type BudgetEstimate,
  type BudgetLimitName,
  type BudgetLimits,
} from "./decision/budget.js";
export { validateQuestions, ValidationError } from "./decision/validate.js";

// The Jev implementation.
export { computeBackoffMs, JevDecisionModel, parseRetryAfter, type JevDecisionModelOptions } from "./jev/client.js";
export {
  describeError,
  JevAuthError,
  JevConnectionError,
  JevError,
  JevOverloadedError,
  JevProtocolError,
  JevRateLimitError,
  JevTimeoutError,
  JevValidationError,
  type JevErrorOptions,
} from "./jev/errors.js";

// Config and MCP assembly, for harnesses that want to expose the same tools.
export { DEFAULTS, loadConfig, MISSING_API_KEY_MESSAGE, type Config, type Env } from "./config.js";
export { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

// Shared tool plumbing.
export { mapWithConcurrency, sumUsage, type ToolConfig } from "./tools/shared.js";

// Each tool's pure `run`, plus its schemas and description.
export {
  augment,
  description as evaluateDescription,
  inputSchema as evaluateInputSchema,
  outputSchema as evaluateOutputSchema,
  run as runEvaluate,
  type EvaluateToolInput,
  type EvaluateToolOutput,
  type GatedAnswer,
} from "./tools/evaluate.js";

export {
  chunkCandidates,
  description as rankDescription,
  inputSchema as rankInputSchema,
  outputSchema as rankOutputSchema,
  run as runRank,
  type RankToolInput,
  type RankToolOutput,
} from "./tools/rank.js";

export {
  description as pickDescription,
  inputSchema as pickInputSchema,
  NONE_KEY as PICK_NONE_KEY,
  outputSchema as pickOutputSchema,
  PickInputError,
  run as runPick,
  type PickToolInput,
  type PickToolOutput,
} from "./tools/pick.js";

export {
  allSupported,
  description as verifyDescription,
  inputSchema as verifyInputSchema,
  outputSchema as verifyOutputSchema,
  run as runVerify,
  VERDICTS,
  type ClaimResult,
  type Verdict,
  type VerifyToolInput,
  type VerifyToolOutput,
} from "./tools/verify.js";

export {
  DECISIONS,
  description as gateActionDescription,
  gateActionPolicy,
  HIGH_BLAST_RADIUS,
  QUESTIONS as GATE_ACTION_QUESTIONS,
  inputSchema as gateActionInputSchema,
  outputSchema as gateActionOutputSchema,
  run as runGateAction,
  type ActionDecision,
  type GateActionCoreInput,
  type GateActionCoreResult,
  type GateActionPolicyInput,
  type GateActionPolicyOptions,
  type GateActionPolicyResult,
  type GateActionRunConfig,
  type GateActionSignals,
  type GateActionToolInput,
  type GateActionToolOutput,
  type UncertainMode,
} from "./tools/gate-action.js";

export {
  description as nextStepDescription,
  inputSchema as nextStepInputSchema,
  MAX_RETRY_ATTEMPTS,
  NEXT_STEPS,
  nextStepPolicy,
  outputSchema as nextStepOutputSchema,
  run as runNextStep,
  type NextStep,
  type NextStepPolicyInput,
  type NextStepPolicyResult,
  type NextStepSignals,
  type NextStepToolInput,
  type NextStepToolOutput,
} from "./tools/next-step.js";

export {
  description as listModelsDescription,
  inputSchema as listModelsInputSchema,
  outputSchema as listModelsOutputSchema,
  run as runListModels,
  type ListModelsToolInput,
  type ListModelsToolOutput,
} from "./tools/list-models.js";
