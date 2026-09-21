/**
 * Stop: catch the stop-short pattern.
 *
 * Jev sees the final message and nothing else — not the workspace, not the
 * diff, not the test output. That rules out second-guessing a clean "done": a
 * model with no view of the work cannot tell a finished task from an
 * unfinished one. What it *can* read is Claude's own admission that work
 * remains, and that is the only thing this hook blocks on.
 *
 * At most one block per user prompt, counted in code. A stop hook that can
 * argue is a stop hook that loops.
 */

import type { NoulAnswer, Question } from "../../decision/types.js";
import { runVerifyCore, type ClaimResult } from "../../tools/verify-core.js";
import { checkReferences, extractClaims, stopClaimsPolicy, type StopClaimsResult } from "../claims.js";
import { redactAndClamp } from "../redact.js";
import { modelCost } from "../store.js";
import { EMPTY_LEDGER, verificationPolicy } from "../verification.js";
import type { Deps, HookInput, HookOutput } from "../types.js";
import { claimsBlockText } from "../wording.js";
import { gitDiffHead, gitNameStatus, projectFileExists, readProjectFile } from "../workspace.js";

/** Evidence pieces the Stop verify is allowed, for its time budget. */
const MAX_CLAIM_PIECES = 2;
/** Change sentences verified against the diff, per stop. */
const MAX_VERIFIED_CLAIMS = 20;

/** Below this, the message is an acknowledgement, not a report. */
export const MIN_MESSAGE_CHARS = 40;
const MAX_MESSAGE_CHARS = 6000;
/** Longest single request entry sent with the final message. */
const MAX_REQUEST_CHARS = 4000;
/** One block per prompt. */
export const MAX_STOP_BLOCKS = 1;

/**
 * The seven questions, and why there are seven.
 *
 * 0.4.x asked one compound question — "was some part NOT done, or skipped, or
 * still failing, or a TODO, or a next step?" — and the live log says it fired on
 * *offers*. Nine of twelve stop records scored `admits_unfinished` at 0.85 or
 * more, and every one of them was a message saying "say the word and I'll ship
 * it": extra work offered on top of the request, not requested work left
 * undone. Only `asks_user` stopped them being wrong blocks, and one record sat
 * a threshold tick away.
 *
 * So the compound is three literal Nouls, OR-ed in code, each with the offer
 * case written into `not_for` on the `true` side — the side it was wrongly
 * landing on.
 */
const QUESTIONS: Record<string, Question> = {
  claims_complete: {
    type: "noul",
    instructions: {
      question: "Does `final_message` say that the work `request.latest` asked for is finished?",
      inspect: "final_message",
    },
    criteria: {
      true: {
        what: "The requested work is reported as done, complete, implemented, fixed, or working.",
        examples: ["Done — all three handlers now log the new field.", "The fix is in and the tests pass."],
      },
      false: {
        what: "No claim that the requested work is finished.",
        examples: ["I've looked at the code and here is what I found.", "Here is a plan for the change."],
      },
    },
  },
  says_part_not_done: {
    type: "noul",
    instructions: {
      question: "Does `final_message` say that a part of the work `request.latest` asked for is not done?",
      inspect: "final_message",
      focus: "Only work the request asked for counts. Extra work offered on top of the request does not.",
    },
    criteria: {
      true: {
        what: "A part of the requested work is described as not done, skipped, or left out.",
        not_for: "An offer to do more than the request asked for.",
        examples: [
          "I have not updated the README yet.",
          "I skipped the migration step.",
          "The CLI flag is still a TODO.",
          "Two of the four files are done.",
        ],
      },
      false: {
        what: "Every part of the requested work is described as done, or the message does not discuss the requested work.",
        examples: [
          "All four files are updated.",
          "I can also add a changelog entry if you want.",
          "Say the word and I'll push it.",
        ],
      },
    },
  },
  says_step_deferred: {
    type: "noul",
    instructions: {
      question:
        "Does `final_message` put off a step that `request.latest` asked for to later, to a next step, or to a follow-up?",
      inspect: "final_message",
      focus: "Deferral of requested work only. A suggestion of additional future work is not a deferral.",
    },
    criteria: {
      true: {
        what: "A requested step is named as a next step, a follow-up, or something to do later.",
        not_for: "Ideas for future work the request did not ask for.",
        examples: [
          "Next I'll wire up the hook; the handler is done.",
          "The tests can be added in a follow-up.",
          "Left for later: the Windows path.",
        ],
      },
      false: {
        what: "No requested step is put off.",
        examples: [
          "A future improvement could be caching, but that's outside this task.",
          "Everything requested is in place.",
        ],
      },
    },
  },
  says_check_failing: {
    type: "noul",
    instructions: {
      question:
        "Does `final_message` say that a test, build, type-check, lint, or command it ran is still failing or still broken?",
      inspect: "final_message",
    },
    criteria: {
      true: {
        what: "Something the message ran or checked is reported as failing, erroring, or broken at the time of writing.",
        not_for: "A failure that the message says was then fixed.",
        examples: [
          "Two tests still fail.",
          "The build errors on the new import; I couldn't resolve it.",
          "tsc reports 3 errors.",
        ],
      },
      false: {
        what: "Nothing is reported as currently failing.",
        examples: ["The tests failed at first; after the fix they pass.", "Type-check is clean."],
      },
    },
  },
  asks_user: {
    type: "noul",
    instructions: {
      question:
        "Is `final_message` waiting for the user to decide something or supply information before the work can continue?",
      inspect: "final_message",
    },
    criteria: {
      true: {
        what: "The message asks a question, offers a choice, or says it needs something from the user.",
        examples: [
          "Which of the two approaches do you prefer?",
          "Say the word and I'll ship either or both.",
          "I need the API key before I can test this.",
        ],
      },
      false: {
        what: "Nothing is asked of the user.",
        examples: ["Done. The tests pass.", "Next I'll wire up the hook."],
      },
    },
  },
  addresses_request: {
    type: "noul",
    instructions: {
      question: "Is `final_message` about what `request.latest` asked for?",
      compare: ["final_message", "request.latest"],
    },
    criteria: {
      true: { what: "The message responds to the request." },
      false: { what: "The message is about something else." },
    },
  },
  /**
   * Deliberately narrow and literal: this is the *claim*, not its truth. What
   * the checks actually did is in the ledger, compared in code.
   */
  claims_verified: {
    type: "noul",
    instructions: {
      question: "Does `final_message` state that tests, a build, a type-check or a lint run passed or succeeded?",
      inspect: "final_message",
    },
    criteria: {
      true: {
        what: "`final_message` says that tests pass, the build succeeds, the type-check is clean, the linter is happy, or equivalent — as something that has already happened.",
      },
      false: {
        what: "`final_message` makes no such claim: it does not mention running tests, a build, a type-check or a lint, or it says they were not run, are still failing, or should be run next.",
      },
    },
  },
};

export interface StopSignals {
  claims_complete: number;
  says_part_not_done: number;
  says_step_deferred: number;
  says_check_failing: number;
  asks_user: number;
  addresses_request: number;
  claims_verified: number;
}

/** Which of the three literal Nouls fired, when one did. */
export type UnfinishedReason = "says_part_not_done" | "says_step_deferred" | "says_check_failing";

/** The three, in the order the block text prefers to name them. */
export const UNFINISHED_REASONS: readonly UnfinishedReason[] = [
  "says_part_not_done",
  "says_step_deferred",
  "says_check_failing",
];

/** What each one says about the message, for the reason list and the block text. */
const UNFINISHED_PHRASE: Record<UnfinishedReason, string> = {
  says_part_not_done: "names a part of the requested work as not done",
  says_step_deferred: "defers a requested step",
  says_check_failing: "reports a check still failing",
};

export interface StopPolicyResult {
  block: boolean;
  reasons: string[];
  /** The Noul that fired, so the block text can name it rather than guess. */
  unfinished_by?: UnfinishedReason;
}

/**
 * Block iff Claude itself said requested work remains and is not waiting on
 * the user.
 *
 * Deliberately narrow. `claims_complete` and `addresses_request` are recorded
 * for calibration but do not gate: "it says it is done" is not evidence that
 * it is, and blocking on it would make this hook an adversary.
 *
 * Unfinished is the max of the three literal Nouls: any one of them at `auto`
 * is Claude saying so about requested work, and which one it was rides out in
 * `unfinished_by` so the block names the finding instead of a compound.
 */
export function stopPolicy(signals: StopSignals, auto: number): StopPolicyResult {
  let firedBy: UnfinishedReason | undefined;
  for (const reason of UNFINISHED_REASONS) {
    if (signals[reason] >= auto && (firedBy === undefined || signals[reason] > signals[firedBy])) {
      firedBy = reason;
    }
  }
  const blocked = signals.asks_user > 1 - auto;
  const reasons: string[] = [];
  if (firedBy !== undefined) {
    reasons.push(`the final message ${UNFINISHED_PHRASE[firedBy]} (p=${signals[firedBy].toFixed(2)})`);
  }
  if (blocked) reasons.push(`the final message is waiting on the user (p=${signals.asks_user.toFixed(2)})`);
  const block = firedBy !== undefined && !blocked;
  return { block, reasons, ...(firedBy !== undefined ? { unfinished_by: firedBy } : {}) };
}

/** The clause a block uses to say what it found. */
export function unfinishedClause(reason: UnfinishedReason, p: number): string {
  return `${UNFINISHED_PHRASE[reason]} (p=${p.toFixed(2)})`;
}

/** Cheap check for a message that ends by asking the user something. */
export function endsWithQuestion(message: string): boolean {
  const tail = message.slice(-200).trimEnd();
  return tail.endsWith("?");
}

export async function handleStop(input: HookInput, deps: Deps): Promise<HookOutput | undefined> {
  const { config, store } = deps;
  if (!config.stopCheck) return undefined;
  if (input.stop_hook_active === true) return undefined;

  const sessionId = input.session_id ?? "unknown";
  if (store.isDisabled(sessionId)) return undefined;

  const eventName = input.hook_event_name === "SubagentStop" ? "SubagentStop" : "Stop";
  // A subagent is judged against the task its parent gave it, not against the
  // user's last prompt — the user never saw the task. Read it before dropping
  // it: this is the event that says the subagent is done with it.
  const subagent = input.agent_type;
  const task = subagent === undefined ? undefined : store.takeSubagentTask(sessionId, subagent, deps.now());
  if (eventName === "SubagentStop" && subagent !== undefined) {
    store.dropSubagentTask(sessionId, subagent, deps.now());
  }

  // A session with work in flight is paused, not finished.
  if ((input.background_tasks ?? []).length > 0) return undefined;
  if ((input.session_crons ?? []).length > 0) return undefined;

  const message = input.last_assistant_message ?? "";
  if (message.trim().length < MIN_MESSAGE_CHARS) return undefined;
  if (endsWithQuestion(message)) return undefined;

  const session = store.readSession(sessionId);
  if (task === undefined && session.prompts.length === 0) return undefined;
  if (session.stop_blocks >= MAX_STOP_BLOCKS) return undefined;
  if (deps.model === null) return undefined;

  const base = {
    ts: new Date(deps.now()).toISOString(),
    session_id: sessionId,
    event: eventName,
    subject: redactAndClamp(message.slice(-300), 300),
  };

  const request =
    task !== undefined
      ? { latest: task.prompt, previous: [] as string[] }
      : {
          latest: redactAndClamp(session.prompts[session.prompts.length - 1] ?? "", MAX_REQUEST_CHARS),
          previous: session.prompts
            .slice(0, -1)
            .map((prompt) => redactAndClamp(prompt, MAX_REQUEST_CHARS)),
        };

  const thresholds = { auto: config.autoThreshold, review: config.reviewThreshold };
  const cwd = input.cwd;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    // The stop-short request and the claim checks run together: the model reads
    // the message while git and the deterministic stage read the workspace.
    const stopRequest = deps.model.evaluate({
      state: {
        request,
        final_message: redactAndClamp(message.slice(-MAX_MESSAGE_CHARS), MAX_MESSAGE_CHARS),
      },
      questions: QUESTIONS,
      signal: controller.signal,
    });

    let claimsPolicy: StopClaimsResult | undefined;
    let claimsTimedOut = false;
    const extracted = cwd === undefined ? undefined : extractClaims(message);
    // Only touch the workspace when the message actually names a file or an
    // identifier: a message with nothing to check has nothing to verify, and
    // skipping the git reads keeps the common case free.
    if (cwd !== undefined && extracted !== undefined && (extracted.files.length > 0 || extracted.idents.length > 0)) {
      try {
        const [nameStatus, headDiff] = await Promise.all([gitNameStatus(cwd), gitDiffHead(cwd)]);
        const stage1 = checkReferences(extracted, {
          fileExists: (rel) => projectFileExists(cwd, rel),
          readFile: (rel) => readProjectFile(cwd, rel),
          nameStatus,
          diffText: headDiff?.text ?? "",
        });
        let verifiedClaims: ClaimResult[] | undefined;
        if (config.verifyClaims && extracted.claims.length > 0 && headDiff !== undefined) {
          try {
            const verify = await runVerifyCore(
              deps.model,
              {
                claims: extracted.claims.map((claim) => claim.text).slice(0, MAX_VERIFIED_CLAIMS),
                evidence: headDiff.text,
                thresholds,
                maxPieces: MAX_CLAIM_PIECES,
              },
              { maxConcurrency: MAX_CLAIM_PIECES },
              controller.signal,
            );
            verifiedClaims = verify.claims;
          } catch {
            // A slow diff or a timed-out verify degrades to stage 1, logged.
            claimsTimedOut = true;
          }
        }
        claimsPolicy = stopClaimsPolicy(stage1, verifiedClaims, config.autoThreshold);
      } catch {
        // Any workspace read failure: fail open, no claim block.
        claimsPolicy = undefined;
      }
    }

    const result = await stopRequest;
    const answers = result.answers as Record<string, NoulAnswer | undefined>;
    const noul = (key: string): number => (typeof answers[key]?.noul === "number" ? (answers[key] as NoulAnswer).noul : 0);
    const signals: StopSignals = {
      claims_complete: noul("claims_complete"),
      says_part_not_done: noul("says_part_not_done"),
      says_step_deferred: noul("says_step_deferred"),
      says_check_failing: noul("says_check_failing"),
      asks_user: noul("asks_user"),
      addresses_request: noul("addresses_request"),
      claims_verified: noul("claims_verified"),
    };

    const policy = stopPolicy(signals, config.autoThreshold);
    // The second rule, and the only one with evidence behind it: the message
    // says the checks pass, and the ledger says the last one did not.
    const verified = verificationPolicy(
      signals.claims_verified,
      session.verification ?? EMPTY_LEDGER,
      config.autoThreshold,
      deps.now(),
    );

    const claimsBlock = claimsPolicy?.block ?? false;
    const blocked = policy.block || verified.block || claimsBlock;
    const decision = blocked
      ? policy.block || verified.block
        ? "block"
        : "claims-block"
      : verified.logOnly
        ? "unverified-claim"
        : claimsTimedOut
          ? "claims-timeout"
          : claimsPolicy !== undefined
            ? "claims-clean"
            : "allow";
    store.append({
      ...base,
      decision,
      signals: { ...signals },
      policy: { auto: config.autoThreshold },
      thresholds: {
        auto: config.autoThreshold,
        review: config.reviewThreshold,
        confidence: config.confidenceThreshold,
      },
      ...(policy.unfinished_by !== undefined ? { unfinished_by: policy.unfinished_by } : {}),
      ...(subagent !== undefined ? { subagent } : {}),
      ...(claimsPolicy !== undefined
        ? { claims: { ...claimsPolicy.counts, items: claimsPolicy.items.slice(0, 5) } }
        : {}),
      reasons: [...policy.reasons, ...verified.reasons],
      ...modelCost(result),
    });

    if (!blocked) return undefined;

    store.updateSession(sessionId, (state) => ({ ...state, stop_blocks: state.stop_blocks + 1 }), deps.now());

    // Precedence: stop-short (oldest, broadest) speaks first, then the
    // verification ledger, then the workspace claim check.
    if (policy.block && policy.unfinished_by !== undefined) {
      const reason = policy.unfinished_by;
      return {
        decision: "block",
        reason:
          `[jev] Your final message ${unfinishedClause(reason, signals[reason])} and is not waiting on the ` +
          `user. Continue with the remaining work, or state explicitly what blocks you.`,
      };
    }

    if (verified.block) return { decision: "block", reason: verified.reason as string };

    return { decision: "block", reason: claimsBlockText((claimsPolicy as StopClaimsResult).items) };
  } catch (error) {
    store.append({
      ...base,
      decision: "error",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
