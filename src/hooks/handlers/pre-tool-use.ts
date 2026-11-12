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
 *    call with an affirmation marker quoting the user, and once the quote is
 *    found in the user's messages it passes without further judgment.
 *
 * A classifier never prompts anybody: for a model, lint or commit trip,
 * `permissionDecision: "ask"` is reachable only through the explicit
 * `ask_on_trip` setting. A code-rule (pattern) trip is different since 0.7:
 * under `pattern_trips: ask`, the default, it *is* a prompt — the user
 * approves or refuses `rm -rf ~` themselves, and a marker from the agent does
 * not clear it — and in a mode with no prompt it is a plain deny. `"allow"` is
 * not representable at all.
 *
 * A fourth, rare shape is a `systemMessage` with no decision: the judgment
 * call failed or timed out, the call went through, and the user is told so
 * at most once per `GATE_ERROR_NOTICE_INTERVAL_MS`. Still fail-open; no
 * longer fail-silent.
 *
 * Order matters: prefilter, then the tripwire, then judgment. The prefilter
 * keeps the model off `ls`; the tripwire answers a re-issue without spending a
 * call on a question it already asked.
 */

import { gateOutcome, bands, NOTE_DEDUPE_TTL_MS } from "../advisory.js";
import { runGateAction, type GateAction, type GateContext, type GateRequest } from "../../tools/gate-action-core.js";
import { FILE_TOOLS, prefilter, SPAWN_TOOLS, structuredAction } from "../prefilter.js";
import { handleLint } from "./lint.js";
import { handleCommit, isGitCommit, mentionsGitCommit } from "./commit.js";
import { compactJson, redact, redactAndClamp } from "../redact.js";
import { modelCost, MAX_PROMPT_CHARS } from "../store.js";
import type { DecisionRecord } from "../store.js";
import { fingerprint, tripIdOf, MAX_REASON_CHARS, type Trip, type TripSource } from "../tripwire.js";
import {
  actionSubject,
  blastLabel,
  gateErrorSystemMessage,
  markerUnverifiedText,
  modelTripText,
  noteText,
  patternTripText,
  tripRepeatText,
  MAX_EMITTED_CHARS,
  type PatternTripNeeds,
} from "../wording.js";
import type { HookConfig } from "../config.js";
import { checkMarker, type MarkerCheck } from "../intent.js";
import { standingDirectives, standingTag, MAX_DIRECTIVE_CHARS, STANDING_PREFIX, type StandingDirective } from "../standing.js";
import type { Deps, EscalatingDecision, HookInput, HookOutput } from "../types.js";

/** Longest tool input we will pay to have judged. */
const MAX_ACTION_CHARS = 4000;
/**
 * How often a session is told that the gate let a call through unjudged.
 *
 * A gate error is almost always an API that is down or slow, which does not
 * fix itself between one tool call and the next; one line every ten minutes
 * says so without turning every call into a complaint.
 */
export const GATE_ERROR_NOTICE_INTERVAL_MS = 10 * 60 * 1000;
/** The free-text fields of the judged action, longest-lived first. */
const ACTION_TEXT_FIELDS = ["command", "content_head", "old_string", "new_string", "text"] as const;
/** Longest `subject` written to the decision log. */
const MAX_LOG_SUBJECT_CHARS = 300;
/** Modes with no prompt to show, so `ask_on_trip` cannot apply. */
const PROMPTLESS_MODES = new Set(["dontAsk", "bypassPermissions"]);

/** The two settings that decide who a trip is addressed to. */
export type TripPolicy = Pick<HookConfig, "askOnTrip" | "patternTrips">;

/**
 * How a trip reaches its audience.
 *
 * The single place `"ask"` is produced in this plugin. A classifier trip
 * (model, lint, commit) asks only when the user set `ask_on_trip`. A code-rule
 * trip asks under `pattern_trips: ask`, the default, never under `deny`, and
 * follows `ask_on_trip` under `advisory`. Neither asks in a mode with no
 * prompt to show. `tests/hooks/never-allow.test.ts` asserts the single site
 * statically: a second expression producing that string is how "a prompt
 * comes from exactly these two settings" would quietly stop being true.
 */
export function tripChannel(policy: TripPolicy, mode: string | undefined, source: TripSource): EscalatingDecision {
  // A code-rule trip under `ask` or `deny` is the user's; `advisory` hands it
  // to `askOnTrip` like a classifier trip. Spelled so this stays the one line
  // in the hook source that produces the string.
  const byRule = source === "pattern" && policy.patternTrips !== "advisory";
  return (byRule ? policy.patternTrips !== "deny" : policy.askOnTrip) && !PROMPTLESS_MODES.has(mode ?? "default") ? "ask" : "deny";
}

/**
 * Whether the agent can clear this trip with a marker.
 *
 * Everything but a code-rule trip under `ask`/`deny`: those are the user's to
 * clear, in the prompt or by hand, and a marker on them is recorded as refused.
 */
export function agentMayAffirm(policy: TripPolicy, source: TripSource): boolean {
  return source !== "pattern" || policy.patternTrips === "advisory";
}

/** What a code-rule trip's text has to say about the way forward. */
function patternNeeds(policy: TripPolicy, channel: EscalatingDecision): PatternTripNeeds {
  return policy.patternTrips === "advisory" ? "advisory" : channel;
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

/** The least of an over-length field's tail that is kept. */
export const MIN_ELIDED_TAIL_CHARS = 1000;

/**
 * Fit `text` into `max` characters by cutting out the middle.
 *
 * The head alone is not enough: `echo <4000 chars of padding>; sudo rm -rf
 * /Users/x` reached the model with the payload cut off, and a command's
 * operative part is as likely to be at its end as its start. So the budget is
 * split about evenly between the head and the tail, with the tail never
 * shorter than `MIN_ELIDED_TAIL_CHARS` while the budget allows, and a marker
 * in between says how much is missing. The result is exactly `max` long.
 *
 * Redaction is the caller's job and has to come first: a secret that
 * straddles the cut would otherwise survive as two halves.
 */
export function elideMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const markerFor = (elided: number): string => `…[${elided} chars elided]…`;
  // The marker counts the characters it replaces, and its own length depends
  // on that count, so settle the two together. A digit rollover moves the
  // count by one and converges on the next pass.
  let marker = markerFor(text.length - max);
  for (let pass = 0; pass < 3; pass += 1) {
    const next = markerFor(text.length - (max - marker.length));
    if (next.length === marker.length) break;
    marker = next;
  }
  const budget = max - marker.length;
  if (budget <= 0) return text.slice(0, max);
  const tail = Math.min(budget, Math.max(MIN_ELIDED_TAIL_CHARS, Math.floor(budget / 2)));
  const head = budget - tail;
  return `${text.slice(0, head)}${markerFor(text.length - budget)}${text.slice(text.length - tail)}`;
}

/**
 * Redact every string in the judged action, and keep the whole of it inside
 * `max`.
 *
 * The per-field caps in `structuredAction` already bound each tool's own
 * shape; this is the guard that holds whatever mix of fields a future tool
 * populates, trimming the longest-lived fields first in one pass. Both cuts
 * keep the head and the tail, for the reason `elideMiddle` gives.
 */
function boundAction(action: GateAction, max: number): GateAction {
  const out: GateAction = { ...action, target_paths: [...action.target_paths] };
  for (const field of ACTION_TEXT_FIELDS) {
    const value = out[field];
    if (typeof value === "string") out[field] = elideMiddle(redact(value), max);
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
    out[field] = elideMiddle(value, keep);
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
export function gateRequest(prompts: readonly string[], max: number, standing: readonly StandingDirective[] = []): GateRequest {
  const latest = redactAndClamp(prompts[prompts.length - 1] ?? "", max);
  let used = latest.length;
  // Standing instructions come next, before the recent prompts, each with a
  // budget of its own: the recent prompts are the ones a long latest prompt
  // may crowd out, and a standing instruction exists because it fell out of
  // that window in the first place. Sent oldest first, ahead of the rest.
  const tagged: string[] = [];
  for (const directive of standing) {
    const room = Math.min(max - used, MAX_DIRECTIVE_CHARS);
    // Too little room to carry even the tag and a few words: stop here
    // rather than send a fragment the caller cannot count as one.
    if (room < MIN_STANDING_ROOM) break;
    const text = redactAndClamp(standingTag(directive), room);
    tagged.unshift(text);
    used += text.length;
  }
  const previous: string[] = [];
  for (let index = prompts.length - 2; index >= 0; index -= 1) {
    const room = max - used;
    if (room <= 0) break;
    previous.unshift(redactAndClamp(prompts[index] as string, room));
    used += (previous[0] as string).length;
  }
  return { latest, previous: [...tagged, ...previous] };
}

/** A verified marker carried into a judgment, to answer a trip it raises. */
export interface MarkerOverride {
  /** The marker text, redacted and clamped. */
  affirmation: string;
  /** `markerFields` of the verdict. */
  fields: Partial<DecisionRecord>;
}

/** The least budget a standing instruction is sent in. */
const MIN_STANDING_ROOM = 80;

/** The log fields that say how a marker fared. */
function markerFields(check: MarkerCheck | undefined): Partial<DecisionRecord> {
  if (check === undefined || check.status === "short") return {};
  if (check.status === "verified") {
    return {
      marker_check: "verified",
      marker_match: { age: check.match.age, message: redactAndClamp(check.match.message, MAX_REASON_CHARS) },
    };
  }
  if (check.status === "legacy") return { marker_check: "legacy" };
  return { marker_check: "unverified", marker_refusal: check.why };
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
  // `CLAUDE_PLUGIN_ROOT` is exported to hook processes and inherited by the
  // daemon SessionStart spawns; it names the files `jev-self-disable` guards.
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT?.trim();
  const verdict = prefilter({
    toolName,
    toolInput,
    cwd,
    strict: config.gate === "strict",
    dataDir: config.dataDir,
    ...(pluginRoot !== undefined && pluginRoot !== "" ? { pluginRoot } : {}),
  });
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
  // The marker's one verdict for this call. Every branch that reads the
  // marker reads this, so the same input gets the same answer; it is computed
  // only on a path that uses it, because it may read the transcript.
  const verdictOfMarker = (): MarkerCheck | undefined =>
    marker === undefined
      ? undefined
      : checkMarker(marker, {
          legacy: config.legacyMarkers,
          transcriptPath: input.transcript_path,
          prompts: store.readSession(sessionId).prompts,
        });

  if (verdict.kind === "affirm") {
    const check = verdictOfMarker();
    const checked = markerFields(check);
    if (marker === undefined || check === undefined || check.status === "short") {
      store.append({ ...base, decision: "marker-short" });
      return undefined;
    }
    const affirmation = redactAndClamp(marker.reason ?? "", MAX_REASON_CHARS);
    const trip = marker.trip_id === undefined ? undefined : store.findTripById(sessionId, marker.trip_id, now);
    if (trip === undefined) {
      store.append({ ...base, decision: "affirm-unmatched", affirmation, ...checked, ...(marker.trip_id !== undefined ? { trip_id: marker.trip_id } : {}) });
      return undefined;
    }
    // A code-rule trip is the user's to clear. The sidecar itself is `true`
    // and runs; the trip stays open and the marker is recorded as refused.
    if (!agentMayAffirm(config, trip.source)) {
      store.append({ ...base, decision: "affirm-refused", trip_id: trip.id, fingerprint: trip.fingerprint, source: trip.source, affirmation, ...checked });
      return undefined;
    }
    // A quote that is not the user's clears nothing. The sidecar is `true`,
    // so denying it costs nothing and is the only way the agent hears why.
    if (check.status === "unverified") {
      const text = markerUnverifiedText({
        id: trip.id,
        tool: toolName,
        why: check.why,
        ...(marker.quote !== undefined ? { quote: redactAndClamp(marker.quote, MAX_REASON_CHARS) } : {}),
        sidecar: true,
      });
      store.append({
        ...base,
        decision: "affirm-unverified",
        trip_id: trip.id,
        fingerprint: trip.fingerprint,
        source: trip.source,
        affirmation,
        ...checked,
        channel: "deny",
        emitted: redactAndClamp(text, MAX_EMITTED_CHARS),
      });
      return tripOutput("deny", text);
    }
    store.affirmTrip(sessionId, trip.id, affirmation, now);
    store.append({ ...base, decision: "affirm", trip_id: trip.id, fingerprint: trip.fingerprint, affirmation, ...checked });
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
  const check = verdictOfMarker();
  const checked = markerFields(check);

  // A legacy-mode marker shorter than the minimum is treated as absent — and
  // counted, so `/jev:calibrate` can show a reflex forming rather than guess at
  // one. Everything else a marker can be is `live`: it either clears the call
  // or is refused out loud, the same way every time.
  if (check?.status === "short") {
    store.append({ ...base, decision: "marker-short", fingerprint: fp, ...(open !== undefined ? { trip_id: open.id } : {}) });
  }
  const live = marker !== undefined && check !== undefined && check.status !== "short";
  const quoteShown = marker?.quote === undefined ? {} : { quote: redactAndClamp(marker.quote, MAX_REASON_CHARS) };

  if (open !== undefined) {
    const affirmation = (live ? marker.reason : undefined) ?? open.affirmation;
    if ((live || affirmation !== undefined) && !agentMayAffirm(config, open.source)) {
      // A marker on a code-rule trip the agent cannot clear. The call is not
      // run, the trip stays open, and the attempt is counted and logged with
      // the marker text so the user can see the reflex forming.
      store.repeatTrip(sessionId, open.id, now);
      const channel = tripChannel(config, input.permission_mode, open.source);
      const text = patternTripText({
        id: open.id,
        pattern: open.pattern ?? "pattern",
        reason: open.reason,
        needs: patternNeeds(config, channel),
        tool: toolName,
        markerRefused: true,
      });
      store.append({
        ...base,
        decision: "marker-refused",
        trip_id: open.id,
        fingerprint: fp,
        source: open.source,
        channel,
        ...(affirmation !== undefined ? { affirmation: redactAndClamp(affirmation, MAX_REASON_CHARS) } : {}),
        ...checked,
        emitted: redactAndClamp(text, MAX_EMITTED_CHARS),
        ...(input.tool_use_id !== undefined ? { tool_use_id: input.tool_use_id } : {}),
      });
      return tripOutput(channel, text);
    }
    if (live && check.status === "unverified") {
      // A marker whose quote is not the user's. Not a re-issue: the call is
      // not run, the trip stays open, and the agent is told which check failed.
      const attempt = store.repeatTrip(sessionId, open.id, now);
      const channel = tripChannel(config, input.permission_mode, open.source);
      const text = markerUnverifiedText({ id: open.id, tool: toolName, why: check.why, ...quoteShown });
      store.append({
        ...base,
        decision: "marker-unverified",
        trip_id: open.id,
        fingerprint: fp,
        source: open.source,
        channel,
        ...(marker.reason !== undefined ? { affirmation: redactAndClamp(marker.reason, MAX_REASON_CHARS) } : {}),
        ...checked,
        emitted: redactAndClamp(`${text} (attempt ${attempt})`, MAX_EMITTED_CHARS),
        ...(input.tool_use_id !== undefined ? { tool_use_id: input.tool_use_id } : {}),
      });
      return tripOutput(channel, text);
    }
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
        ...checked,
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
    const channel = tripChannel(config, input.permission_mode, open.source);
    const text = tripRepeatText({
      id: open.id,
      attempt,
      seconds: (now - open.ts) / 1000,
      ...(open.source === "pattern" ? { needs: patternNeeds(config, channel) } : {}),
      ...(check?.status === "short" ? { shortMarker: true } : {}),
    });
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

  // Row 5: a marker on a call with no trip open against it.
  //
  // Before 0.7.2 it was stripped, logged and ignored, and the call was judged
  // as if it carried none — so a marked call could be refused, and the very
  // same call accepted a moment later because the refusal had opened a trip
  // for it to answer. Now the verdict above decides it, the same way every
  // time, and the judgment still runs:
  //
  //  - unverified (the quote is not the user's, or there is none): denied with
  //    the reason, whatever the classifier would have said — a fabricated
  //    quote is worth surfacing even on a harmless call;
  //  - verified: the call is judged as usual; if the judgment trips, the
  //    marker overrides it (`marker-pass`, no trip opened), and if it does not,
  //    the marker is logged as verified and unused. A marker never switches
  //    the classifier off: it only answers a trip the classifier raised;
  //  - legacy-accepted (unquoted, under `legacy_markers`): the 0.7.1 rule —
  //    logged as unmatched, judged, and answerable only as a re-issue.
  //
  // A code-rule trip the agent may not clear outranks all of it.
  const userOwned = verdict.kind === "escalate" && !agentMayAffirm(config, "pattern");
  if (live && (userOwned || check.status === "legacy")) {
    store.append({
      ...base,
      decision: "marker-unmatched",
      fingerprint: fp,
      ...(marker.reason !== undefined ? { affirmation: redactAndClamp(marker.reason, MAX_REASON_CHARS) } : {}),
      ...checked,
    });
  } else if (live && check.status === "unverified") {
    const channel = tripChannel(config, input.permission_mode, "model");
    const text = markerUnverifiedText({ tool: toolName, why: check.why, ...quoteShown });
    store.append({
      ...base,
      decision: "marker-unverified",
      fingerprint: fp,
      channel,
      ...(marker.reason !== undefined ? { affirmation: redactAndClamp(marker.reason, MAX_REASON_CHARS) } : {}),
      ...checked,
      emitted: redactAndClamp(text, MAX_EMITTED_CHARS),
      ...(input.tool_use_id !== undefined ? { tool_use_id: input.tool_use_id } : {}),
    });
    return tripOutput(channel, text);
  }
  /** A verified marker standing by to answer a trip the judgment below may raise. */
  const override: MarkerOverride | undefined =
    live && !userOwned && check.status === "verified"
      ? { affirmation: redactAndClamp(marker.reason ?? "", MAX_REASON_CHARS), fields: checked }
      : undefined;
  /** The fields a passing judgment's record carries when a verified marker went unused. */
  const unused: Partial<DecisionRecord> = override === undefined ? {} : { ...override.fields, marker_used: false };
  /** Pass a call whose judgment tripped, on the strength of a verified marker. */
  const passOnMarker = (record: Partial<DecisionRecord>): undefined => {
    store.append({
      ...base,
      ...record,
      decision: "marker-pass",
      fingerprint: fp,
      affirmation: (override as MarkerOverride).affirmation,
      ...(override as MarkerOverride).fields,
      marker_used: true,
      ...(input.tool_use_id !== undefined ? { tool_use_id: input.tool_use_id } : {}),
    } as DecisionRecord);
    if (input.tool_use_id !== undefined) {
      store.rememberReissue(sessionId, { tool_use_id: input.tool_use_id, ts: now, tool_name: toolName });
    }
    return undefined;
  };

  if (verdict.kind === "escalate") {
    // Row 2: a code rule matched. Certain by construction; no model consulted.
    // Under `pattern_trips: ask` (the default) this is the user's call to
    // make, in the permission prompt; a marker from the agent will not clear it.
    // Under `pattern_trips: advisory` the trip is the agent's to answer, so a
    // verified marker answers it here instead of on a re-issue.
    if (override !== undefined) {
      return passOnMarker({ source: "pattern", reasons: [verdict.reason] });
    }
    const id = tripIdOf(fp);
    const channel = tripChannel(config, input.permission_mode, "pattern");
    const text = patternTripText({
      id,
      pattern: verdict.pattern,
      reason: verdict.reason,
      needs: patternNeeds(config, channel),
      tool: toolName,
    });
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

  // A lone `git commit` with nothing open against it: the commit-time lint in
  // place of the gate. It runs after the open-trip machinery, so an affirmed
  // commit re-runs through the same reissue path as any Bash trip, and after
  // the code rules, so no prefix can carry a command past a pattern trip. A
  // compound command that contains a commit is not lone and is judged below.
  if (
    toolName === "Bash" &&
    config.lint !== "off" &&
    isGitCommit(typeof action.command === "string" ? action.command : undefined)
  ) {
    return handleCommit(input, deps, action.command as string, base, fp, now, override);
  }

  // Row 6: from here on a judgment is needed. No model means no opinion, and
  // a verified marker had nothing to answer.
  if (deps.model === null) {
    if (override !== undefined) store.append({ ...base, decision: "marker-unused", fingerprint: fp, affirmation: override.affirmation, ...unused });
    return undefined;
  }

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
  // Standing instructions widen the user's request, never a subagent's task:
  // a subagent is doing what its parent told it, not what the user said
  // twenty prompts ago.
  const wantStanding: StandingDirective[] =
    subagent === undefined && session.prompts.length > 0 ? standingDirectives(session, config.standingDirectives) : [];
  const userRequest: GateRequest | undefined =
    task !== undefined
      ? {
          latest: task.prompt,
          previous: session.prompts.length > 0 ? [redactAndClamp(session.prompts[session.prompts.length - 1] as string, MAX_ACTION_CHARS)] : [],
        }
      : subagent !== undefined
        ? undefined
        : session.prompts.length > 0
          ? gateRequest(session.prompts, MAX_ACTION_CHARS, wantStanding)
          : undefined;
  // The ones that fit the budget: `gateRequest` takes them newest first and
  // stops at the first that does not, so they are a prefix of the list.
  const standing = wantStanding.slice(
    0,
    task === undefined && userRequest !== undefined ? userRequest.previous.filter((p) => p.startsWith(STANDING_PREFIX)).length : 0,
  );
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
      ...(standing.length > 0
        ? { standing: standing.map((d) => ({ age: d.age, text: redactAndClamp(d.text, MAX_REASON_CHARS) })) }
        : {}),
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
    /** How many user prompts the scope judgment actually had to read, standing instructions apart. */
    const prompts = userRequest === undefined ? 0 : 1 + userRequest.previous.length - standing.length;

    if (outcome.outcome === "trip") {
      // The judgment tripped and a verified marker quotes the user asking for
      // it: the marker answers the trip now, and no trip is opened.
      if (override !== undefined) return passOnMarker({ ...record, source: "model", firm });
      const id = tripIdOf(fp);
      const channel = tripChannel(config, input.permission_mode, "model");
      const text = modelTripText({
        id,
        tool: toolName,
        signals: result.signals,
        prompts,
        p_unrelated: scope.unrelated,
        sidecar: toolName !== "Bash",
        ...(standing.length > 0 ? { standing } : {}),
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
        ...unused,
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
      ...unused,
      decision: suppressed === "allow" ? "allow" : `silent-${suppressed}`,
      suppressed,
      ...(firm.length > 0 ? { firm } : {}),
    });
    // A compound command with a commit in it (`git add -A && git commit -m x`)
    // went through the code rules and the gate like any other call. Once the
    // gate has nothing to say, the commit in it still gets the commit lint.
    const command = typeof action.command === "string" ? action.command : undefined;
    if (toolName === "Bash" && config.lint !== "off" && mentionsGitCommit(command)) {
      return handleCommit(input, deps, command as string, base, fp, now, override);
    }
    return undefined;
  } catch (error) {
    // Fail open, but not in silence: the call runs, and the user is told —
    // once per interval, because an API that is down stays down for a while.
    // Never a decision, never a prompt; a `systemMessage` is all this is.
    const name = error instanceof Error ? error.name : "";
    const cause = /AbortError|TimeoutError/.test(name) ? "timeout" : name !== "" ? name : "error";
    // The store swallows its own I/O errors, but this is the fail-open path
    // and nothing in it may throw: a broken session file costs at most an
    // extra notice, never the notice itself.
    let last: number | undefined;
    try {
      last = store.readSession(sessionId).gate_error_notice_at;
    } catch {
      last = undefined;
    }
    const notify = last === undefined || now - last >= GATE_ERROR_NOTICE_INTERVAL_MS;
    const text = notify ? gateErrorSystemMessage({ cause }) : undefined;
    if (text !== undefined) {
      try {
        store.updateSession(sessionId, (state) => ({ ...state, gate_error_notice_at: now }), now);
      } catch {
        // The notice still goes out; the next one may just come sooner.
      }
    }
    store.append({
      ...base,
      ...unused,
      decision: "error",
      fingerprint: fp,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      ...(text !== undefined ? { emitted: redactAndClamp(text, MAX_EMITTED_CHARS) } : {}),
    });
    return text === undefined ? undefined : { systemMessage: text };
  } finally {
    clearTimeout(timer);
  }
}
