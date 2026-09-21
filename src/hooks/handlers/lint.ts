/**
 * The semantic code lint on an in-project edit: judged before the write, a
 * tripwire for a hardcoded secret or an unrequested removed test, an advisory
 * note for everything else.
 *
 * It reuses the gate's trip lifecycle — the same fingerprint, the same open
 * trip, the same sidecar `true # jev:intended t-…` affirmation — so an edit that
 * tripped and was affirmed passes on re-issue exactly as a Bash call does. The
 * regex gate in `lint-prefilter.ts` has already decided most edits cost nothing.
 */

import { MAX_NOTES_PER_PROMPT, NOTE_DEDUPE_TTL_MS } from "../advisory.js";
import { readProjectConventions } from "../conventions.js";
import { lintOutcome, lintQuestions, lintState, runLint, type LintJudgeInput } from "../lint-core.js";
import { lintPrefilter, type LintEditInput } from "../lint-prefilter.js";
import { redactAndClamp, redact } from "../redact.js";
import { modelCost, requestText, MAX_PROMPT_CHARS, type DecisionRecord } from "../store.js";
import { fingerprint, tripIdOf, MAX_REASON_CHARS, type Trip } from "../tripwire.js";
import { lintNoteText, lintTripText, tripRepeatText, MAX_EMITTED_CHARS } from "../wording.js";
import { readProjectFile } from "../workspace.js";
import type { Deps, HookInput, HookOutput } from "../types.js";
import { noteOutput, tripChannel, tripOutput } from "./pre-tool-use.js";

/** MultiEdit: edits flattened, capped. */
const MAX_MULTI_EDITS = 8;
const MAX_EDIT_CHARS = 4000;

function pathOf(toolInput: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = toolInput[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function relativize(cwd: string, path: string): string {
  return path.startsWith(cwd) ? path.slice(cwd.length + 1) : path;
}

/** Build the lint's view of the edit from the tool input, reading old content for a Write. */
function editInputOf(toolName: string, toolInput: Record<string, unknown>, cwd: string): LintEditInput | undefined {
  const path = pathOf(toolInput);
  if (path === undefined) return undefined;
  const str = (key: string): string | undefined => (typeof toolInput[key] === "string" ? (toolInput[key] as string) : undefined);

  if (toolName === "Edit" || toolName === "Update") {
    return { tool: toolName, file_path: path, old: str("old_string") ?? "", new: str("new_string") ?? "" };
  }
  if (toolName === "MultiEdit") {
    const raw = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    const edits = raw.slice(0, MAX_MULTI_EDITS).map((e) => {
      const edit = (e ?? {}) as Record<string, unknown>;
      return {
        old_string: String(edit.old_string ?? "").slice(0, MAX_EDIT_CHARS),
        new_string: String(edit.new_string ?? "").slice(0, MAX_EDIT_CHARS),
      };
    });
    return { tool: toolName, file_path: path, new: "", edits };
  }
  // Write / NotebookEdit: the new content, plus the current file as `old` so a
  // rewrite's removed lines exist.
  const content = str("content") ?? str("new_source") ?? "";
  const read = readProjectFile(cwd, relativize(cwd, path));
  const old = read.kind === "text" ? read.text : "";
  return { tool: toolName, file_path: path, old, new: content };
}

export async function handleLint(
  input: HookInput,
  deps: Deps,
  action: Record<string, unknown>,
  base: Partial<DecisionRecord> & { ts: string; session_id: string; event: string },
  now: number,
): Promise<HookOutput | undefined> {
  const { config, store } = deps;
  const sessionId = input.session_id ?? "unknown";
  const toolName = input.tool_name ?? "";
  const cwd = input.cwd ?? process.cwd();

  const editInput = editInputOf(toolName, action, cwd);
  if (editInput === undefined) return undefined;

  const conventions =
    config.lintConventions && config.lint === "advisory" ? readProjectConventions(cwd) : [];
  const pre = lintPrefilter(editInput, conventions.length > 0);
  if (pre.kind === "skip") {
    // Skips are sampled: every too-large one, one in ten of the rest, so the
    // log shows the skip rate without a record per keystroke.
    if (pre.reason === "too-large" || Math.floor(now / 100) % 10 === 0) {
      store.append({ ...base, kind: "lint", decision: "lint-skip", prefilter: pre.reason });
    }
    return undefined;
  }

  const fp = fingerprint(toolName, action);
  const open = store.findTripByFingerprint(sessionId, fp, now);

  if (open !== undefined) {
    if (open.affirmation !== undefined) {
      store.closeTrip(sessionId, open.id, now);
      store.append({
        ...base,
        kind: "lint",
        decision: "reissue",
        trip_id: open.id,
        fingerprint: fp,
        source: open.source,
        affirmation: redactAndClamp(open.affirmation, MAX_REASON_CHARS),
      });
      if (input.tool_use_id !== undefined) {
        store.rememberReissue(sessionId, { tool_use_id: input.tool_use_id, ts: now, tool_name: toolName, trip_id: open.id });
      }
      return undefined;
    }
    const attempt = store.repeatTrip(sessionId, open.id, now);
    const channel = tripChannel(config.askOnTrip, input.permission_mode);
    const text = tripRepeatText({ id: open.id, attempt, seconds: (now - open.ts) / 1000 });
    store.append({ ...base, kind: "lint", decision: "trip-repeat", trip_id: open.id, fingerprint: fp, source: open.source, channel, emitted: redactAndClamp(text, MAX_EMITTED_CHARS) });
    return tripOutput(channel, text);
  }

  if (deps.model === null) return undefined;

  const session = store.readSession(sessionId);
  const hasRequest = session.prompts.length > 0;
  const judge: LintJudgeInput = {
    file_path: relativize(cwd, editInput.file_path),
    language: pre.language,
    change:
      editInput.edits !== undefined
        ? { kind: "multi_edit", content: editInput.edits.map((e) => e.new_string).join("\n") }
        : toolName === "Write" || toolName === "NotebookEdit"
          ? { kind: "write", content: editInput.new, old_string: editInput.old ?? "" }
          : { kind: "edit", old_string: editInput.old ?? "", new_string: editInput.new },
    removed_lines: pre.removed,
    added_lines: pre.added,
    conventions,
    ...(hasRequest ? { user_request: requestText(session.prompts, MAX_PROMPT_CHARS) } : {}),
  };
  const questions = lintQuestions(pre.ask, conventions, hasRequest);
  const fileField = redact(judge.file_path);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const result = await runLint(deps.model, lintState(judge), questions, controller.signal);
    const duplicate = store.wasNoted(sessionId, fp, NOTE_DEDUPE_TTL_MS, now);
    const outcome = lintOutcome({
      signals: result.signals,
      conventions,
      thresholds: { auto: config.autoThreshold, review: config.reviewThreshold },
      duplicate,
      notesThisPrompt: session.notes_this_prompt ?? 0,
      cap: MAX_NOTES_PER_PROMPT,
      level: config.lint,
    });

    const record: DecisionRecord = {
      ...base,
      kind: "lint",
      file: fileField,
      signals: result.signals,
      findings: outcome.findings.map((f) => (f.convention !== undefined ? `conv:${f.convention.slice(0, 60)}` : f.id)),
      ...modelCost(result),
    } as DecisionRecord;

    if (outcome.outcome === "trip" && outcome.trip !== undefined) {
      const id = tripIdOf(fp);
      const channel = tripChannel(config.askOnTrip, input.permission_mode);
      const p = result.signals[outcome.trip] ?? 0;
      const text = lintTripText({ id, tool: toolName, finding: outcome.trip, p });
      const trip: Trip = {
        id,
        fingerprint: fp,
        tool_name: toolName,
        ts: now,
        source: "lint",
        reason: redactAndClamp(outcome.trip, MAX_REASON_CHARS),
        denies: 1,
      };
      store.openTrip(sessionId, trip, now);
      store.append({ ...record, decision: "lint-trip", trip_id: id, source: "lint", channel, emitted: redactAndClamp(text, MAX_EMITTED_CHARS) });
      return tripOutput(channel, text);
    }

    if (outcome.outcome === "note") {
      const text = lintNoteText({
        tool: toolName,
        subject: fileField,
        findings: outcome.findings,
        sawConventions: conventions.length > 0,
      });
      store.noteEmitted(sessionId, fp, now);
      store.append({ ...record, decision: "lint-note", channel: "note", emitted: redactAndClamp(text, MAX_EMITTED_CHARS) });
      return noteOutput(text);
    }

    store.append({ ...record, decision: `lint-silent-${outcome.suppressed ?? "uncertain"}` });
    return undefined;
  } catch (error) {
    store.append({ ...base, kind: "lint", decision: "lint-error", file: fileField, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
