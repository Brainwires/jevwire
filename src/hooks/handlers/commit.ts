/**
 * The commit-time lint: a `git commit` about to run is checked for scope (does
 * the staged diff bundle several independent changes), for whether its message
 * describes the diff, and for a secret written straight into the diff. Notes for
 * the first two, a tripwire for the secret. Runs after the open-trip machinery,
 * so an affirmed commit re-runs like any other Bash trip.
 */

import { commitOutcome, commitQuestions, commitState, addedLinesOf } from "../commit-core.js";
import { looksLikeSecretLiteral } from "../lint-prefilter.js";
import { scanBash } from "../prefilter.js";
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

/** Stands in for an inert commit message while the command line is scanned. */
const MESSAGE_PLACEHOLDER = "MSG";
const QUOTED_HEREDOC_OPEN = /"\$\(cat <<(['"])([A-Za-z0-9_]+)\1\n/g;

/** Does `text` end outside every quote and escape, the way a shell reads it? */
function unquotedAtEnd(text: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
    } else if (c === "\\") {
      if (i === text.length - 1) return false;
      i += 1;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
    } else if (c === "'" || c === '"') {
      quote = c;
    }
  }
  return quote === undefined;
}

/**
 * Parentheses in a here-document body that no shell can read as the end of
 * the `$( … )` around it. Older shells (bash 3.2) find that end by counting
 * parentheses, quote-aware, even inside the body; balanced parentheses with no
 * quote characters beside them cannot close it early.
 */
function parensAreInert(body: string): boolean {
  if (!body.includes(")")) return true;
  if (/['"`\\]/.test(body)) return false;
  let depth = 0;
  for (const c of body) {
    if (c === "(") depth += 1;
    else if (c === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Replace each `"$(cat <<'EOF' … EOF)"` message with a plain word.
 *
 * That is the shape Claude Code writes a multi-line commit message in. With a
 * quoted delimiter the body is literal text — no expansion, no substitution —
 * so it cannot run anything, and the body ends at the first line that is the
 * delimiter exactly, as it does in the shell. Anything that does not have that
 * shape all the way to the closing `)"` returns undefined: the command is then
 * not a lone commit and goes through the gate.
 */
function withInertMessages(command: string): string | undefined {
  let out = "";
  let from = 0;
  QUOTED_HEREDOC_OPEN.lastIndex = 0;
  for (let m = QUOTED_HEREDOC_OPEN.exec(command); m !== null; m = QUOTED_HEREDOC_OPEN.exec(command)) {
    // Inside a quote the opener is not an opener at all: `'"$(cat <<'EOF'` …
    // closes and reopens single quotes, and what looks like a body can be
    // unquoted shell.
    if (!unquotedAtEnd(out + command.slice(from, m.index))) return undefined;
    const delimiter = m[2] as string;
    const bodyStart = m.index + m[0].length;
    let lineStart = bodyStart;
    let bodyEnd = -1;
    while (lineStart <= command.length) {
      const newline = command.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? command.length : newline;
      if (command.slice(lineStart, lineEnd) === delimiter) {
        bodyEnd = lineEnd;
        break;
      }
      if (newline === -1) break;
      lineStart = newline + 1;
    }
    if (bodyEnd === -1) return undefined;
    if (!parensAreInert(command.slice(bodyStart, bodyEnd))) return undefined;
    const close = /^[ \t\n]*\)"/.exec(command.slice(bodyEnd));
    if (close === null) return undefined;
    out += `${command.slice(from, m.index)}"${MESSAGE_PLACEHOLDER}"`;
    from = bodyEnd + close[0].length;
    QUOTED_HEREDOC_OPEN.lastIndex = from;
  }
  return out + command.slice(from);
}

/**
 * Is this Bash command a lone, real `git commit` (not `--dry-run`)?
 *
 * Only then does the call take the commit-time lint instead of the gate, so
 * the bar is the whole command line: one simple command whose first word is
 * `git` and whose second is `commit` — no `git -c …` or other option in
 * between, no assignment or path in front, no `&&` / `||` / `;` / `&` / pipe /
 * newline, no substitution, expansion, subshell, redirect or here-document.
 * A compound command that merely contains a commit is judged like any other
 * call, and its pattern trips apply in either case.
 */
export function isGitCommit(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  const plain = withInertMessages(command);
  if (plain === undefined) return false;
  const scan = scanBash(plain);
  const { redirect, substitution, expansion, grouping, heredoc, unbalanced } = scan.features;
  if (redirect || substitution || expansion || grouping || heredoc || unbalanced) return false;
  if (scan.segments.length !== 1) return false;
  const tokens = scan.segments[0] as string[];
  if (tokens[0] !== "git" || tokens[1] !== "commit") return false;
  if (tokens.some((token) => /^--dry-run(=|$)/.test(token))) return false;
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
      const channel = tripChannel(config, input.permission_mode, "commit");
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
