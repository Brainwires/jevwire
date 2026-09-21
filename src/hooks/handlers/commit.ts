/**
 * The commit-time lint: a `git commit` about to run is checked for scope (does
 * the staged diff bundle several independent changes), for whether its message
 * describes the diff, and for a secret written straight into the diff. Notes for
 * the first two, a tripwire for the secret. Runs after the open-trip machinery,
 * so an affirmed commit re-runs like any other Bash trip.
 */

import { commitOutcome, commitQuestions, commitState, addedLinesOf } from "../commit-core.js";
import { looksLikeSecretLiteral } from "../lint-prefilter.js";
import { redactAndClamp } from "../redact.js";
import { modelCost, requestText, MAX_PROMPT_CHARS, type DecisionRecord } from "../store.js";
import { fingerprint, tripIdOf, MAX_REASON_CHARS, type Trip } from "../tripwire.js";
import { commitScopeNoteText, commitSecretTripText, MAX_EMITTED_CHARS } from "../wording.js";
import { gitStagedDiff } from "../workspace.js";
import type { NoulAnswer, ScoreAnswer } from "../../decision/types.js";
import { MAX_NOTES_PER_PROMPT, NOTE_DEDUPE_TTL_MS } from "../advisory.js";
import type { Deps, HookInput, HookOutput } from "../types.js";
import { noteOutput, tripChannel, tripOutput } from "./pre-tool-use.js";

/** Longest staged diff sent to the model (head + tail at hunk boundaries done by the reader). */
const MAX_COMMIT_DIFF = 24_000;

/** Is this Bash command a real `git commit` (not `--dry-run`)? */
export function isGitCommit(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  if (!/\bgit\b[^\n|;&]*\bcommit\b/.test(command)) return false;
  if (/--dry-run\b/.test(command)) return false;
  return true;
}

/** The `-m "…"` or `-F` message, when the command carries one. */
function commitMessage(command: string): string | undefined {
  const m = /-m\s+("([^"]*)"|'([^']*)'|(\S+))/.exec(command);
  if (m !== null) return m[2] ?? m[3] ?? m[4];
  if (/-F\b/.test(command)) return "(message from a file)";
  return undefined;
}

function countFiles(diff: string): number {
  return (diff.match(/^diff --git /gm) ?? []).length;
}
function countDeleted(diff: string): number {
  return diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
}

export async function handleCommit(
  input: HookInput,
  deps: Deps,
  command: string,
  base: Partial<DecisionRecord> & { ts: string; session_id: string; event: string },
  fp: string,
  now: number,
): Promise<HookOutput | undefined> {
  const { config, store } = deps;
  const sessionId = input.session_id ?? "unknown";
  const cwd = input.cwd ?? process.cwd();
  if (deps.model === null) return undefined;

  const staged = await gitStagedDiff(cwd);
  if (staged === undefined || staged.text.trim() === "") {
    // Not a repo, git unavailable, or nothing staged: nothing to judge.
    return undefined;
  }

  const diff = staged.text.slice(0, MAX_COMMIT_DIFF);
  const added = addedLinesOf(diff);
  const askSecret = added.some(looksLikeSecretLiteral);
  const message = commitMessage(command);
  const hasMessage = message !== undefined;
  const session = store.readSession(sessionId);

  const state = commitState({
    stat: staged.stat.slice(0, 4000),
    diff,
    added_lines: added.slice(0, 120),
    askSecret,
    hasMessage,
    ...(message !== undefined ? { commit_message: message } : {}),
    ...(session.prompts.length > 0 ? { user_request: requestText(session.prompts, MAX_PROMPT_CHARS) } : {}),
  });
  const questions = commitQuestions({ askSecret, hasMessage });

  // Dedupe the note on the staged diff itself: re-running the same commit does
  // not re-note. The trip is keyed on the command, like any Bash trip.
  const diffFp = fingerprint("commit", { diff });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const result = await deps.model.evaluate({ state, questions, signal: controller.signal });
    const answers = result.answers as Record<string, NoulAnswer | ScoreAnswer | undefined>;
    const secretAnswer = answers.hardcodes_secret?.type === "noul" ? answers.hardcodes_secret : undefined;
    const outcome = commitOutcome(
      {
        pr_scope: answers.pr_scope !== undefined && answers.pr_scope.type === "score" ? answers.pr_scope : undefined,
        message_describes_diff:
          answers.message_describes_diff !== undefined && answers.message_describes_diff.type === "noul"
            ? answers.message_describes_diff
            : undefined,
        hardcodes_secret: secretAnswer,
      },
      { auto: config.autoThreshold, review: config.reviewThreshold },
    );

    const record: DecisionRecord = {
      ...base,
      kind: "commit",
      signals: {
        ...(outcome.scope_p3 !== undefined ? { pr_scope_3: outcome.scope_p3 } : {}),
        ...(outcome.message_describes !== undefined ? { message_describes_diff: outcome.message_describes } : {}),
        ...(outcome.secretTrip ? { hardcodes_secret: secretAnswer?.noul ?? 0 } : {}),
      },
      ...modelCost(result),
    } as DecisionRecord;

    if (outcome.secretTrip) {
      const id = tripIdOf(fp);
      const channel = tripChannel(config.askOnTrip, input.permission_mode);
      const text = commitSecretTripText({ id, p: secretAnswer?.noul ?? 0 });
      const trip: Trip = { id, fingerprint: fp, tool_name: "Bash", ts: now, source: "commit", reason: "staged secret", denies: 1 };
      store.openTrip(sessionId, trip, now);
      store.append({ ...record, decision: "commit-trip", trip_id: id, source: "commit", channel, emitted: redactAndClamp(text, MAX_EMITTED_CHARS) });
      return tripOutput(channel, text);
    }

    if (outcome.scopeNote || outcome.messageNote) {
      if (store.wasNoted(sessionId, diffFp, NOTE_DEDUPE_TTL_MS, now) || (session.notes_this_prompt ?? 0) >= MAX_NOTES_PER_PROMPT) {
        store.append({ ...record, decision: "commit-silent" });
        return undefined;
      }
      const text = commitScopeNoteText({
        files: countFiles(diff),
        added: added.length,
        deleted: countDeleted(diff),
        ...(outcome.scopeNote ? { scope_p3: outcome.scope_p3 } : {}),
        ...(outcome.messageNote ? { message_describes: outcome.message_describes } : {}),
      });
      store.noteEmitted(sessionId, diffFp, now);
      store.append({ ...record, decision: "commit-note", channel: "note", emitted: redactAndClamp(text, MAX_EMITTED_CHARS) });
      return noteOutput(text);
    }

    store.append({ ...record, decision: "commit-silent" });
    return undefined;
  } catch (error) {
    store.append({ ...base, kind: "commit", decision: "commit-error", error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
