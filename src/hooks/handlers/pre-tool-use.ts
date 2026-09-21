/**
 * PreToolUse: the advisory gate.
 *
 * Three outcomes, and the difference between them is the whole design:
 *
 *  - **silent** — the common case. No output, no prompt, often no model call.
 *  - **note** — `additionalContext`, which Claude Code delivers *next to the
 *    tool result*, i.e. after the call ran. A note is therefore information for
 *    the agent's next decision, never a gate. It says what was scored and
 *    stops.
 *  - **trip** — `deny`. The only thing here that acts before execution. The
 *    text rides in `permissionDecisionReason`, because `additionalContext` is
 *    dropped when the call is blocked. The agent may re-issue the identical
 *    call with an affirmation marker and it passes without further judgment.
 *
 * Nobody is prompted. `permissionDecision: "ask"` is reachable only through the
 * explicit `ask_on_trip` setting, and `"allow"` is not representable at all.
 *
 * Order matters: prefilter, then the tripwire, then judgment. The prefilter
 * keeps the model off `ls`; the tripwire answers a re-issue without spending a
 * call on a question it already asked.
 */

import { gateOutcome, bands, NOTE_DEDUPE_TTL_MS } from "../advisory.js";
import { runGateAction, type GateAction, type GateContext, type GateRequest } from "../../tools/gate-action-core.js";
import { FILE_TOOLS, prefilter, SPAWN_TOOLS, structuredAction } from "../prefilter.js";
import { handleLint } from "./lint.js";
import { compactJson, redact, redactAndClamp } from "../redact.js";
import { modelCost, MAX_PROMPT_CHARS } from "../store.js";
import type { DecisionRecord } from "../store.js";
import { fingerprint, tripIdOf, MAX_REASON_CHARS, type Trip } from "../tripwire.js";
import {
  actionSubject,
  blastLabel,
  modelTripText,
  noteText,
  patternTripText,
  tripRepeatText,
  MAX_EMITTED_CHARS,
} from "../wording.js";
import type { Deps, EscalatingDecision, HookInput, HookOutput } from "../types.js";

/** Longest tool input we will pay to have judged. */
const MAX_ACTION_CHARS = 4000;
/** The free-text fields of the judged action, longest-lived first. */
const ACTION_TEXT_FIELDS = ["command", "content_head", "old_string", "new_string", "text"] as const;
/** Longest `subject` written to the decision log. */
const MAX_LOG_SUBJECT_CHARS = 300;
/** Modes with no prompt to show, so `ask_on_trip` cannot apply. */
const PROMPTLESS_MODES = new Set(["dontAsk", "bypassPermissions"]);

/**
 * How a trip reaches its audience.
 *
 * The single place `"ask"` is produced in this plugin, and it is unreachable
 * unless the user set `ask_on_trip`. `tests/hooks/never-allow.test.ts` asserts
 * that statically, because "the hooks never prompt" is the promise of this
 * release and a second occurrence of that string is how it would quietly break.
 */
export function tripChannel(askOnTrip: boolean, mode: string | undefined): EscalatingDecision {
  return askOnTrip && !PROMPTLESS_MODES.has(mode ?? "default") ? "ask" : "deny";
}

/** A trip: the text goes in the reason, where a blocked call can still show it. */
export function tripOutput(channel: EscalatingDecision, reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: channel,
      permissionDecisionReason: reason,
    },
  };
}

/** A note: delivered with the tool result, with no permission decision at all. */
export function noteOutput(text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } };
}

/**
 * Redact every string in the judged action, and keep the whole of it inside
 * `max`.
 *
 * The per-field caps in `structuredAction` already bound each tool's own
 * shape; this is the guard that holds whatever mix of fields a future tool
 * populates, trimming the longest-lived fields first in one pass.
 */
function boundAction(action: GateAction, max: number): GateAction {
  const out: GateAction = { ...action, target_paths: [...action.target_paths] };
  for (const field of ACTION_TEXT_FIELDS) {
    const value = out[field];
    if (typeof value === "string") out[field] = redactAndClamp(value, max);
  }
  if (out.input !== undefined) out.input = JSON.parse(redact(compactJson(out.input))) as typeof out.input;
  out.target_paths = out.target_paths.map((path) => redact(path));

  let over = compactJson(out).length - max;
  for (const field of ACTION_TEXT_FIELDS) {
    if (over <= 0) break;
    const value = out[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const keep = Math.max(0, value.length - over);
    over -= value.length - keep;
    out[field] = value.slice(0, keep);
  }
  return out;
}

/**
 * The user's request, split into the one that is current and the ones before
 * it, within a total character budget.
 *
 * Filled from the newest backwards, like `requestText` before it: what gets
 * cut is the oldest context and never the instruction the user just gave.
 */
export function gateRequest(prompts: readonly string[], max: number): GateRequest {
  const latest = redactAndClamp(prompts[prompts.length - 1] ?? "", max);
  const previous: string[] = [];
  let used = latest.length;
  for (let index = prompts.length - 2; index >= 0; index -= 1) {
    const room = max - used;
    if (room <= 0) break;
    previous.unshift(redactAndClamp(prompts[index] as string, room));
    used += (previous[0] as string).length;
  }
  return { latest, previous };
}

export async function handlePreToolUse(input: HookInput, deps: Deps): Promise<HookOutput | undefined> {
  const { config, store } = deps;
  if (config.gate === "off") return undefined;

  const sessionId = input.session_id ?? "unknown";
  const toolName = input.tool_name;
  if (toolName === undefined || toolName === "") return undefined;
  if (store.isDisabled(sessionId)) return undefined;

  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const cwd = input.cwd ?? process.cwd();
  const verdict = prefilter({ toolName, toolInput, cwd, strict: config.gate === "strict" });
  /** Marker text is never part of the action: not for the hash, not for Jev. */
  const action = verdict.stripped ?? toolInput;
  const marker = verdict.marker;
  const now = deps.now();

  const base = {
    ts: new Date(now).toISOString(),
    session_id: sessionId,
    event: "PreToolUse",
    tool_name: toolName,
    subject: redactAndClamp(`${toolName} ${compactJson(action)}`, MAX_LOG_SUBJECT_CHARS),
    prefilter: verdict.reason,
  } satisfies Partial<DecisionRecord> & { ts: string; session_id: string; event: string };

  // A `true # jev:intended t-…: <reason>` call: the sidecar affirmation, which
  // is how a Write, an Edit or an MCP call answers a tripwire. It emits nothing.
  if (verdict.kind === "affirm") {
    if (marker?.reason === undefined) {
      store.append({ ...base, decision: "marker-short" });
      return undefined;
    }
    const affirmation = redactAndClamp(marker.reason, MAX_REASON_CHARS);
    const trip = marker.trip_id === undefined ? undefined : store.findTripById(sessionId, marker.trip_id, now);
    if (trip === undefined) {
      store.append({ ...base, decision: "affirm-unmatched", affirmation, ...(marker.trip_id !== undefined ? { trip_id: marker.trip_id } : {}) });
      return undefined;
    }
    store.affirmTrip(sessionId, trip.id, affirmation, now);
    store.append({ ...base, decision: "affirm", trip_id: trip.id, fingerprint: trip.fingerprint, affirmation });
    return undefined;
  }

  // A subagent spawn. Bookkeeping only: the parent's `prompt` here is the task
  // the subagent is about to work on, and without it every call that subagent
  // makes is judged against what the *user* last asked for — which is how four
  // of the five model trips in the first live week happened.
  if (SPAWN_TOOLS.has(toolName)) {
    const agentType = toolInput.subagent_type;
    const prompt = toolInput.prompt;
    if (typeof agentType === "string" && agentType !== "" && typeof prompt === "string" && prompt !== "") {
      store.rememberSubagentTask(
        sessionId,
        { agent_type: agentType, prompt: redactAndClamp(prompt, MAX_PROMPT_CHARS), ts: now },
        now,
      );
    }
    return undefined;
  }

  // An in-project file write is a skip for the gate (it destroys nothing and
  // reaches nowhere) but the place the semantic lint runs. It has its own
  // trip lifecycle, sharing the fingerprint and the sidecar affirmation.
  if (verdict.kind === "skip") {
    if (verdict.writesInProject === true && FILE_TOOLS.has(toolName) && config.lint !== "off") {
      return handleLint(input, deps, action, base, now);
    }
    return undefined;
  }

  const fp = fingerprint(toolName, action);
  const open = store.findTripByFingerprint(sessionId, fp, now);

  // A marker shorter than the minimum is treated as absent — and counted, so
  // `/jev:calibrate` can show a reflex forming rather than guess at one.
  if (marker?.short === true) {
    store.append({ ...base, decision: "marker-short", fingerprint: fp, ...(open !== undefined ? { trip_id: open.id } : {}) });
  }

  if (open !== undefined) {
    const affirmation = marker?.reason ?? open.affirmation;
    if (affirmation !== undefined) {
      // Row 3: affirmed. No judging, no model call, nothing on stdout.
      store.closeTrip(sessionId, open.id, now);
      store.append({
        ...base,
        decision: "reissue",
        trip_id: open.id,
        fingerprint: fp,
        source: open.source,
        affirmation: redactAndClamp(affirmation, MAX_REASON_CHARS),
        ...(input.tool_use_id !== undefined ? { tool_use_id: input.tool_use_id } : {}),
      });
      if (input.tool_use_id !== undefined) {
        store.rememberReissue(sessionId, {
          tool_use_id: input.tool_use_id,
          ts: now,
          tool_name: toolName,
          trip_id: open.id,
        });
      }
      return undefined;
    }

    // Row 4: the same call again, still without a reason.
    const attempt = store.repeatTrip(sessionId, open.id, now);
    const channel = tripChannel(config.askOnTrip, input.permission_mode);
    const text = tripRepeatText({ id: open.id, attempt, seconds: (now - open.ts) / 1000 });
    store.append({
      ...base,
      decision: "trip-repeat",
      trip_id: open.id,
      fingerprint: fp,
      source: open.source,
      channel,
      emitted: redactAndClamp(text, MAX_EMITTED_CHARS),
    });
    return tripOutput(channel, text);
  }

  // Row 5: a marker on a call that was never tripped. It has already been
  // stripped out of `action`; all that is left is to say so in the log.
  if (marker?.reason !== undefined) {
    store.append({
      ...base,
      decision: "marker-unmatched",
      fingerprint: fp,
      affirmation: redactAndClamp(marker.reason, MAX_REASON_CHARS),
    });
  }

  if (verdict.kind === "escalate") {
    // Row 2: a code rule matched. Certain by construction; no model consulted.
    const id = tripIdOf(fp);
    const channel = tripChannel(config.askOnTrip, input.permission_mode);
    const text = patternTripText({ id, pattern: verdict.pattern, reason: verdict.reason });
    const trip: Trip = {
      id,
      fingerprint: fp,
      tool_name: toolName,
      ts: now,
      source: "pattern",
      pattern: verdict.pattern,
      reason: redactAndClamp(verdict.reason, MAX_REASON_CHARS),
      denies: 1,
    };
    store.openTrip(sessionId, trip, now);
    store.append({
      ...base,
      decision: "trip",
      trip_id: id,
      fingerprint: fp,
      source: "pattern",
      channel,
      reasons: [verdict.reason],
      emitted: redactAndClamp(text, MAX_EMITTED_CHARS),
      ...(input.tool_use_id !== undefined ? { tool_use_id: input.tool_use_id } : {}),
    });
    return tripOutput(channel, text);
  }

  // Row 6: from here on a judgment is needed. No model means no opinion.
  if (deps.model === null) return undefined;

  const session = store.readSession(sessionId);

  /**
   * What stands in for the user's request.
   *
   * Inside a subagent it is the task the parent handed it, not the user's last
   * prompt — judging a subagent's work against a prompt it never saw is what
   * made every instrumental file rewrite read as out of scope. When two
   * same-type subagents are running there is no way to tell which one is
   * calling, so scope is ignored rather than judged against the wrong task.
   */
  const subagent = input.agent_type;
  const task = subagent === undefined ? undefined : store.takeSubagentTask(sessionId, subagent, now);
  const userRequest: GateRequest | undefined =
    task !== undefined
      ? {
          latest: task.prompt,
          previous: session.prompts.length > 0 ? [redactAndClamp(session.prompts[session.prompts.length - 1] as string, MAX_ACTION_CHARS)] : [],
        }
      : subagent !== undefined
        ? undefined
        : session.prompts.length > 0
          ? gateRequest(session.prompts, MAX_ACTION_CHARS)
          : undefined;
  const knownRequest = userRequest !== undefined;
  const scopeSource: NonNullable<DecisionRecord["scope_source"]> =
    task !== undefined ? "subagent_task" : knownRequest ? "prompts" : "none";

  const context: GateContext = { cwd };
  if (subagent !== undefined) context.subagent = subagent;
  if (input.permission_mode !== undefined) context.permission_mode = input.permission_mode;

  const strict = config.gate === "strict";
  const policyOptions = {
    ignoreScope: !knownRequest,
    uncertain: strict ? ("confirm" as const) : ("risky-lean" as const),
    // Strict mode keeps every reason to speak up. Advisory mode drops the three
    // that fire on ordinary, requested work.
    lenientScope: !strict,
    trustRequested: !strict,
    corroborateUncertain: !strict,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const result = await runGateAction(
      deps.model,
      {
        action: boundAction(structuredAction(toolName, action, cwd), MAX_ACTION_CHARS),
        user_request: userRequest ?? { latest: "(unknown)", previous: [] },
        context,
        policy: policyOptions,
      },
      {
        model: config.model,
        thresholds: { auto: config.autoThreshold, review: config.reviewThreshold },
        maxConcurrency: 1,
      },
      controller.signal,
    );

    const { scope } = result;
    const signals = {
      ...result.signals,
      blast_radius: result.blast_radius.score,
      scope_unrelated: scope.unrelated,
      scope_step: scope.step,
      scope_requested: scope.requested,
      mentions_target: scope.mentions_target,
      same_task_area: scope.same_task_area,
      ...(result.blast_radius.p_high !== undefined ? { blast_p_high: result.blast_radius.p_high } : {}),
    };
    const record: DecisionRecord = {
      ...base,
      decision: result.decision,
      fingerprint: fp,
      signals,
      policy: {
        ignore_scope: policyOptions.ignoreScope,
        uncertain: policyOptions.uncertain,
        lenient_scope: policyOptions.lenientScope,
        trust_requested: policyOptions.trustRequested,
        corroborate_uncertain: policyOptions.corroborateUncertain,
      },
      thresholds: {
        auto: result.thresholds.auto,
        review: result.thresholds.review,
        confidence: config.confidenceThreshold,
      },
      blast_source: result.blast_radius.source,
      scope_source: scopeSource,
      ...(subagent !== undefined ? { subagent } : {}),
      reasons: result.reasons,
      ...modelCost(result),
    };
    if (input.tool_use_id !== undefined) record.tool_use_id = input.tool_use_id;

    const outcome = gateOutcome({
      decision: result.decision,
      signals: result.signals,
      blast_radius: result.blast_radius.score,
      ...(result.blast_radius.p_high !== undefined ? { blast_p_high: result.blast_radius.p_high } : {}),
      mentions_target: scope.mentions_target,
      thresholds: result.thresholds,
      strict,
      duplicate: store.wasNoted(sessionId, fp, NOTE_DEDUPE_TTL_MS, now),
      notes_this_prompt: session.notes_this_prompt ?? 0,
    });
    const firm: string[] = [...outcome.firm];
    /** How many requests the scope judgment actually had to read. */
    const prompts = userRequest === undefined ? 0 : 1 + userRequest.previous.length;

    if (outcome.outcome === "trip") {
      const id = tripIdOf(fp);
      const channel = tripChannel(config.askOnTrip, input.permission_mode);
      const text = modelTripText({
        id,
        tool: toolName,
        signals: result.signals,
        prompts,
        p_unrelated: scope.unrelated,
        sidecar: toolName !== "Bash",
      });
      store.openTrip(
        sessionId,
        {
          id,
          fingerprint: fp,
          tool_name: toolName,
          ts: now,
          source: "model",
          reason: redactAndClamp(result.reasons.slice(0, 2).join(" "), MAX_REASON_CHARS),
          signals,
          denies: 1,
        },
        now,
      );
      store.append({
        ...record,
        decision: "trip",
        trip_id: id,
        source: "model",
        channel,
        firm,
        emitted: redactAndClamp(text, MAX_EMITTED_CHARS),
      });
      return tripOutput(channel, text);
    }

    if (outcome.outcome === "note") {
      const { requestedish } = bands({
        signals: result.signals,
        blast_radius: result.blast_radius.score,
        ...(result.blast_radius.p_high !== undefined ? { blast_p_high: result.blast_radius.p_high } : {}),
        mentions_target: scope.mentions_target,
        thresholds: result.thresholds,
      });
      const text = noteText({
        tool: toolName,
        subject: actionSubject(toolName, action),
        signals: result.signals,
        blast: {
          label: blastLabel(result.blast_radius.level),
          p_level: result.blast_radius.p_level,
          p_high: result.blast_radius.p_high,
        },
        prompts,
        scope: {
          requestedish,
          p_unrelated: scope.unrelated,
          mentions_target: scope.mentions_target,
        },
        firm: outcome.firm,
      });
      store.noteEmitted(sessionId, fp, now);
      store.append({
        ...record,
        decision: "note",
        channel: "note",
        firm,
        emitted: redactAndClamp(text, MAX_EMITTED_CHARS),
      });
      return noteOutput(text);
    }

    // Silent. The suppression reason is the point of the record: it is how
    // `/jev:calibrate` reports what the gate chose not to say.
    const suppressed = outcome.suppressed ?? "allow";
    store.append({
      ...record,
      decision: suppressed === "allow" ? "allow" : `silent-${suppressed}`,
      suppressed,
      ...(firm.length > 0 ? { firm } : {}),
    });
    return undefined;
  } catch (error) {
    store.append({
      ...base,
      decision: "error",
      fingerprint: fp,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
