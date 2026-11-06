/**
 * The reports behind `/jev:status`, `/jev:why` and `/jev:calibrate`.
 *
 * These are plain functions over the decision log so they can be tested
 * without a process. They print text, not JSON: the audience is a person
 * reading a slash command's output.
 *
 * The API key is never printed, not even partially. "configured" or "not
 * configured" is the whole of what a status report needs to say about it.
 */

import { USD_PER_MTOK } from "../decision/pricing.js";
import { gateActionPolicy, type GateActionSignals } from "../tools/gate-action-core.js";
import { gateOutcome, MAX_NOTES_PER_PROMPT } from "./advisory.js";
import type { HookConfig, PatternTripPolicy } from "./config.js";
import { isAlive, probeHealth, type Health, type Probe } from "./daemon/control.js";
import { PROTOCOL } from "./daemon/protocol.js";
import { daemonLogPath, readDaemonState, type DaemonState } from "./daemon/state-file.js";
import type { DecisionRecord, Store } from "./store.js";

/** TypeSafe bills input tokens only. Defined in `src/decision/pricing.ts`. */
export { USD_PER_MTOK };
const DAY_MS = 24 * 60 * 60 * 1000;

/** What each `pattern_trips` value means, as the status line says it. */
const PATTERN_TRIP_NOTES: Record<PatternTripPolicy, string> = {
  ask: " (a code-rule trip asks the user; denied where no prompt is shown)",
  deny: " (a code-rule trip is always denied; no marker clears it)",
  advisory: " (a code-rule trip denies to Claude, which may re-issue it with a marker)",
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] as number;
}

function tally(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function formatTally(counts: Map<string, number>): string {
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "  (none)";
  return entries.map(([key, count]) => `  ${key}: ${count}`).join("\n");
}

function within(records: DecisionRecord[], now: number, windowMs: number): DecisionRecord[] {
  return records.filter((record) => {
    const ts = Date.parse(record.ts ?? "");
    return Number.isFinite(ts) && now - ts <= windowMs;
  });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * Everything `/jev:status` and `/jev:daemon status` know about the daemon.
 *
 * Two independent sources, kept separate rather than reconciled: the state file
 * the daemon writes (plus whether its pid is still alive) and a live 300 ms
 * probe of the port. They disagree in a case that is common rather than
 * exotic — a `/jev:*` command runs through the Bash tool, whose process may be
 * sandboxed away from loopback sockets — and a report that collapsed them into
 * one "up/down" would confidently say "down" about a daemon that is serving
 * hooks perfectly well. So both are reported, and the wording says which is
 * which.
 */
export interface DaemonView {
  state: DaemonState | undefined;
  /** The pid in the state file exists. Says nothing about whether it answers. */
  alive: boolean;
  probe: Probe["kind"] | "skipped";
  health: Health | undefined;
  logPath: string;
}

export async function daemonView(config: HookConfig, _now: number = Date.now()): Promise<DaemonView> {
  const state = readDaemonState(config.dataDir);
  const probe = await probeHealth(config.daemonPort, 300);
  return {
    state,
    alive: state !== undefined && isAlive(state.pid),
    probe: probe.kind,
    health: probe.kind === "jev" ? probe.health : undefined,
    logPath: daemonLogPath(config.dataDir),
  };
}

function duration(raw: number): string {
  if (!Number.isFinite(raw)) return "?";
  // Clamped rather than rejected: the report's `now` is captured when the
  // command starts, and a heartbeat written a moment later is legitimately in
  // its future. "just now" is the right answer, not "?".
  const ms = Math.max(0, raw);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * The "Daemon" section, as lines.
 *
 * Shared by `/jev:status` and `/jev:daemon status` so the two can never
 * disagree about what is running.
 */
export function daemonReport(config: HookConfig, view: DaemonView, now: number = Date.now()): string[] {
  const lines = ["Daemon", `  port: 127.0.0.1:${config.daemonPort}   protocol: ${PROTOCOL}`];
  const { state, health } = view;
  const fingerprints = health?.key_fingerprints;

  if (health !== undefined) {
    lines.push(
      `  status: up, answering on this shell's loopback`,
      `  pid ${health.pid}, version ${health.version}, protocol ${health.protocol}, up ${duration(health.uptime_ms)}`,
      `  sessions registered: ${health.sessions}   auth: ${health.auth}${
        health.auth === "none" ? " (no API key configured anywhere: unauthenticated, and nothing to spend)" : ""
      }${fingerprints !== undefined && fingerprints.length > 0 ? ` (fingerprints ${fingerprints.join(", ")})` : ""}`,
    );
    if (health.protocol !== PROTOCOL) {
      lines.push(
        `  NOTE: it speaks protocol ${health.protocol} and this build speaks ${PROTOCOL}; the next session start replaces it.`,
      );
    }
  } else if (state === undefined) {
    lines.push("  status: down — no daemon.json in the data directory, so one has never run here.");
  } else if (state.state === "port-conflict") {
    lines.push(
      `  status: PORT CONFLICT — something that is not jev answered on ${config.daemonPort}.`,
      "  The http hooks post there and get nothing useful back, so they are inactive. They fail open:",
      "  nothing is blocked. Free the port and restart the session.",
    );
  } else if (state.state === "stopped") {
    lines.push(`  status: down — stopped ${duration(now - state.updated_at)} ago (pid ${state.pid} was its last).`);
  } else if (view.alive) {
    // The honest version of the sandbox case.
    lines.push(
      `  status: the state file says running and pid ${state.pid} is alive, but it is not reachable from this shell.`,
      `  That is the normal reading for a /jev:* command: this process runs through the Bash tool, which may`,
      `  be sandboxed away from loopback sockets. The hooks talk to it from Claude Code's own process.`,
      `  last heartbeat: ${duration(now - state.updated_at)} ago${
        now - state.updated_at > 60_000 ? " — stale for a 15 s heartbeat, so it may be wedged" : ""
      }`,
    );
  } else {
    lines.push(
      `  status: down — the state file claims running, but pid ${state.pid} no longer exists.`,
      `  Last heartbeat ${duration(now - state.updated_at)} ago. The next session start spawns a fresh one.`,
    );
  }

  if (state !== undefined) {
    lines.push(
      `  state file: ${state.state}, version ${state.version}, restarts ${state.restarts}`,
      `  bundle: ${state.bundle_path === "" ? "(unknown)" : state.bundle_path}`,
    );
  }

  // Live counters when the probe got through; otherwise the state file's, which
  // lag by up to one 15 s heartbeat and are labelled as such.
  const counters = health?.counters ?? state?.counters;
  if (counters !== undefined) {
    const hooks = Object.entries(counters.hooks).sort((a, b) => b[1] - a[1]);
    lines.push(
      `  hooks served: ${hooks.length === 0 ? "(none yet)" : hooks.map(([event, n]) => `${event} ${n}`).join(", ")}`,
      `  jev calls: ${counters.jev_calls}   memo hits: ${counters.memo_hits}   ` +
        `timeouts: ${counters.jev_timeouts}   errors: ${counters.jev_errors}`,
      `  sessions: ${counters.sessions_started} started, ${counters.sessions_ended} ended   ` +
        `deadline overruns: ${counters.deadline_overruns}`,
      `  rejected: ${counters.unauthorized} unauthorized, ${counters.protocol_mismatch} wrong protocol, ` +
        `${counters.unknown_event} unknown event, ${counters.bad_request} unparseable, ${counters.oversize} oversize`,
      ...(counters.session_auth > 0
        ? [
            `  served by session id: ${counters.session_auth} (headers carried no key this daemon holds; the body named a known session)`,
          ]
        : []),
      ...(counters.unauthorized > 0
        ? [
            `  ${counters.unauthorized} hook posts carried no key this daemon holds and named no session it knows. A session becomes known at SessionStart; the hooks' key header is only filled when TYPESAFE_API_KEY is exported in the shell.`,
          ]
        : []),
      health?.counters === undefined
        ? "  counters read from the state file, which is rewritten every 15 s, so they lag by up to that."
        : "  counters read live from the daemon.",
    );
  }
  if (state !== undefined || health !== undefined) lines.push(`  log: ${view.logPath}`);

  return lines;
}

export function statusReport(
  config: HookConfig,
  store: Store,
  now: number = Date.now(),
  daemon?: DaemonView,
): string {
  const all = store.readLog();
  const recent = within(all, now, DAY_MS);
  const count = (...decisions: string[]): number =>
    recent.filter((r) => decisions.includes(r.decision ?? "")).length;
  // Model calls only. A `reissue-ran` record's latency_ms is the time from the
  // re-issue to the tool finishing, which is not a Jev call.
  // Memo hits are excluded: they report 0 ms honestly, but a percentile over
  // calls that never happened would flatter the real latency.
  const latencies = recent
    .filter((r) => r.model !== undefined && r.memo !== true)
    .map((r) => r.latency_ms)
    .filter((n): n is number => typeof n === "number");
  const tokens = recent.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0);
  const errors = recent.filter((r) => r.decision === "error" || r.error !== undefined);
  const lastError = errors[errors.length - 1];

  const lines: string[] = [
    "jev — Claude Code plugin status",
    "",
    "Configuration",
    `  API key: ${config.apiKey === null ? "not configured (judgment hooks inactive)" : "configured"}`,
    `  model: ${config.model}`,
    `  base url: ${config.baseUrl}`,
    `  gate: ${config.gate}`,
    `  ask_on_trip: ${config.askOnTrip}${config.askOnTrip ? "" : " (a classifier tripwire denies to Claude; the user is not prompted)"}`,
    `  pattern_trips: ${config.patternTrips}${PATTERN_TRIP_NOTES[config.patternTrips]}`,
    `  stop_check: ${config.stopCheck}   screen_results: ${config.screenResults}   route_prompts: ${config.routePrompts}`,
    `  thresholds: auto ${config.autoThreshold}, review ${config.reviewThreshold}, choice confidence ${config.confidenceThreshold}`,
    `  per-call timeout: ${config.timeoutMs} ms, retries: ${config.maxRetries}`,
    `  data dir: ${config.dataDir}`,
    `  hooks disabled by env: ${config.disabled}`,
  ];
  if (config.warnings.length > 0) {
    lines.push("  option warnings:");
    for (const warning of config.warnings) lines.push(`    ${warning}`);
  }

  lines.push(
    "",
    `Last 24 h (${recent.length} logged decisions of ${all.length} total)`,
    `  notes handed to Claude: ${count("note")}   suppressed: ${
      recent.filter((r) => (r.decision ?? "").startsWith("silent-")).length
    }`,
    `  tripwires: ${count("trip")} opened, ${count("trip-repeat")} repeats, ${count("reissue")} re-issued (${count(
      "reissue-ran",
    )} ran, ${count("reissue-failed")} failed)`,
    `  markers: ${count("affirm")} sidecar affirmations, ${count("marker-unmatched")} on untripped calls, ${count(
      "marker-short",
    )} too short`,
    " by event:",
    formatTally(tally(recent.map((r) => r.event ?? "?"))),
    " by decision:",
    formatTally(tally(recent.map((r) => r.decision ?? "?"))),
    "",
    "Latency and cost",
    `  p50 ${Math.round(percentile(latencies, 50))} ms, p95 ${Math.round(percentile(latencies, 95))} ms (${latencies.length} calls)`,
    `  input tokens: ${tokens} → about $${((tokens / 1_000_000) * USD_PER_MTOK).toFixed(4)} at $${USD_PER_MTOK}/Mtok`,
    `  errors: ${errors.length}`,
  );
  if (lastError !== undefined) {
    lines.push(`  last error: ${lastError.ts} ${lastError.event} ${lastError.error ?? "(unspecified)"}`);
  }

  const memoHits = recent.filter((r) => r.memo === true).length;
  if (memoHits > 0) {
    lines.push(
      `  of those, ${memoHits} were answered from the daemon's memo: no call, no tokens, and excluded above.`,
    );
  }

  // Omitted rather than faked when the caller did not probe: `statusReport` is
  // synchronous and a probe is not, so a caller that cannot await one (a test,
  // a library embedding) gets the report it asked for and no invented facts.
  if (daemon !== undefined) {
    lines.push("", ...daemonReport(config, daemon, now));
  }

  return lines.join("\n");
}

/** What `/jev:why` shows with no filter: everything the agent was told, plus errors. */
const WHY_ALL = ["note", "trip", "trip-repeat", "reissue", "affirm", "marker-refused", "affirm-refused", "error"];
/**
 * `/jev:why <n> trips`: the tripwire story, including how each trip ended —
 * and, for a code-rule trip, the markers the agent wrote that cleared nothing.
 */
const WHY_TRIPS = ["trip", "trip-repeat", "reissue", "affirm", "marker-refused", "affirm-refused", "reissue-ran", "reissue-failed"];

export type WhyFilter = "all" | "notes" | "trips";

export function whyReport(store: Store, limit = 3, filter: WhyFilter = "all"): string {
  const wanted = filter === "notes" ? ["note"] : filter === "trips" ? WHY_TRIPS : WHY_ALL;
  const interesting = store.readLog().filter((r) => wanted.includes(r.decision ?? ""));
  const slice = interesting.slice(-Math.max(1, limit)).reverse();
  const what = filter === "all" ? "note, trip and error" : filter === "notes" ? "note" : "tripwire";
  if (slice.length === 0) return `jev — no ${what} records yet.`;

  const lines = [`jev — last ${slice.length} ${what} record(s), newest first`, ""];
  for (const record of slice) {
    lines.push(`${record.ts}  ${record.event}  →  ${record.decision}`);
    if (record.tool_name !== undefined) lines.push(`  tool: ${record.tool_name}`);
    if (record.trip_id !== undefined) {
      lines.push(`  tripwire: ${record.trip_id}${record.source === undefined ? "" : ` (${record.source})`}`);
    }
    if (record.subject !== undefined) lines.push(`  subject: ${record.subject}`);
    if (record.prefilter !== undefined) lines.push(`  prefilter: ${record.prefilter}`);
    // The exact text the agent was handed, so "why did Claude say that" is
    // answerable without guessing at which template fired.
    if (record.emitted !== undefined) lines.push(`  said to Claude: ${record.emitted}`);
    if (record.affirmation !== undefined) lines.push(`  marker text: ${record.affirmation}`);
    if (record.firm !== undefined && record.firm.length > 0) lines.push(`  driven by: ${record.firm.join(", ")}`);
    if (record.suppressed !== undefined) lines.push(`  not said because: ${record.suppressed}`);
    if (record.signals !== undefined) {
      lines.push(
        `  signals: ${Object.entries(record.signals)
          .map(([name, value]) => `${name}=${value.toFixed(2)}`)
          .join(", ")}`,
      );
    }
    if (record.policy !== undefined) {
      // Every option in force, because "why did this fire" usually turns out
      // to be "which leniency was or was not switched on".
      const options = [
        `uncertain=${String(record.policy.uncertain)}`,
        `in_scope ${flag(record, "ignore_scope") === true ? "ignored" : "used"}`,
      ];
      for (const name of ["lenient_scope", "trust_requested", "corroborate_uncertain"]) {
        const value = flag(record, name);
        if (value !== undefined) options.push(`${name}=${value}`);
      }
      lines.push(`  policy: ${options.join(", ")}`);
    }
    if (record.scope_source !== undefined) {
      lines.push(`  scope read from: ${record.scope_source}${record.subagent === undefined ? "" : ` (${record.subagent})`}`);
    }
    if (record.unfinished_by !== undefined) lines.push(`  unfinished by: ${record.unfinished_by}`);
    for (const reason of record.reasons ?? []) lines.push(`  - ${reason}`);
    if (record.error !== undefined) lines.push(`  error: ${record.error}`);
    if (record.model !== undefined) {
      lines.push(`  ${record.model}, ${record.latency_ms ?? "?"} ms, ${record.input_tokens ?? "?"} input tokens`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const BUCKETS = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.01];

function histogram(values: number[]): string {
  if (values.length === 0) return "(no samples)";
  const counts = BUCKETS.slice(0, -1).map(
    (low, index) => values.filter((v) => v >= low && v < (BUCKETS[index + 1] as number)).length,
  );
  return counts
    .map((count, index) => `${(BUCKETS[index] as number).toFixed(2)}–${(BUCKETS[index + 1] as number).toFixed(2)}: ${count}`)
    .join("  ");
}

const GATE_SIGNALS = ["destructive", "outward_facing", "in_scope", "credential_exposure"] as const;

/** Signals 0.5.0 added to a judged gate record. Absent on an older one. */
const SCOPE_SIGNALS = ["scope_unrelated", "scope_step", "scope_requested", "mentions_target", "blast_p_high"] as const;

/** The three Nouls that replaced the 0.4.x compound `admits_unfinished`. */
const UNFINISHED_SIGNALS = ["says_part_not_done", "says_step_deferred", "says_check_failing"] as const;

/** A boolean policy option, when the log actually recorded one. */
function flag(record: DecisionRecord, name: string): boolean | undefined {
  const value = record.policy?.[name];
  return typeof value === "boolean" ? value : undefined;
}

/** One numeric signal off a record, when the log has it. */
function signal(record: DecisionRecord, name: string): number | undefined {
  const value = record.signals?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Signals kept in the log for a judged gate decision. */
interface LoggedSignals {
  destructive: number;
  outward_facing: number;
  in_scope: number;
  credential_exposure: number;
  blast_radius: number;
}

function loggedSignals(record: DecisionRecord): LoggedSignals {
  const signals = (record.signals ?? {}) as Record<string, number>;
  return {
    destructive: signals.destructive ?? 0.5,
    outward_facing: signals.outward_facing ?? 0.5,
    in_scope: signals.in_scope ?? 0.5,
    credential_exposure: signals.credential_exposure ?? 0.5,
    blast_radius: signals.blast_radius ?? 2,
  };
}

/**
 * Re-run one logged gate decision through the policy and the advisory table.
 *
 * Exact, not an estimate: the signals, the blast radius and every policy option
 * in force were written to the log, so this is the same pure pair of functions
 * the hook ran, with one honest gap — the per-session duplicate check and the
 * per-prompt cap are session state, not log state, so the replay counts what
 * the table called for before those two suppressions.
 *
 * `blast_p_high` and `mentions_target` are passed only when the record carries
 * them. A record written before 0.5.0 has neither, and then the expectation
 * rule and the un-vetoed out-of-scope reading apply — which is what that record
 * actually decided on.
 */
function replayGate(record: DecisionRecord, auto: number, review: number): "note" | "trip" | "silent" {
  const { blast_radius, ...signals } = loggedSignals(record);
  const thresholds = { auto, review: Math.min(review, auto) };
  const strict = record.policy?.uncertain === "confirm";
  const pHigh = signal(record, "blast_p_high");
  const mentions = signal(record, "mentions_target");
  const zeroFive = {
    ...(pHigh !== undefined ? { blast_p_high: pHigh } : {}),
    ...(mentions !== undefined ? { mentions_target: mentions } : {}),
  };
  const policy = gateActionPolicy({
    signals: signals satisfies GateActionSignals,
    blast_radius,
    ...zeroFive,
    thresholds,
    options: {
      ignoreScope: flag(record, "ignore_scope") ?? false,
      uncertain: strict ? "confirm" : "risky-lean",
      lenientScope: flag(record, "lenient_scope") ?? false,
      trustRequested: flag(record, "trust_requested") ?? false,
      corroborateUncertain: flag(record, "corroborate_uncertain") ?? false,
    },
  });
  return gateOutcome({
    decision: policy.decision,
    signals,
    blast_radius,
    ...zeroFive,
    thresholds,
    strict,
  }).outcome;
}

/**
 * Re-run one logged Stop decision.
 *
 * The three 0.5.0 Nouls when they are there, the 0.4.x compound
 * `admits_unfinished` when they are not. The verification-ledger rule is
 * deliberately not replayed: what the last check command did is session state,
 * not log state, so a replay of it would be a guess dressed as an exact count.
 */
function replayStop(record: DecisionRecord, auto: number): "block" | "allow" {
  const split = UNFINISHED_SIGNALS.map((name) => signal(record, name)).filter(
    (value): value is number => value !== undefined,
  );
  const unfinished = split.length > 0 ? Math.max(...split) : signal(record, "admits_unfinished");
  if (unfinished === undefined) return "allow";
  const asksUser = signal(record, "asks_user") ?? 0;
  return unfinished >= auto && !(asksUser > 1 - auto) ? "block" : "allow";
}

/** Re-run one logged PostToolUse screen, in the cascade's order. */
function replayScreen(record: DecisionRecord, auto: number): "flagged" | "contradicts" | "clean" {
  if ((signal(record, "injection") ?? 0) >= auto) return "flagged";
  if ((signal(record, "contradicts_premise") ?? 0) >= auto) return "contradicts";
  return "clean";
}

/** Re-run one logged prompt classification at another confidence bar. */
function replayKind(record: DecisionRecord, confidence: number): "printed" | "low-confidence" {
  return (signal(record, "kind_confidence") ?? 0) >= confidence ? "printed" : "low-confidence";
}

/** The signal that drove a note or a trip, for the by-signal tallies. */
function driver(record: DecisionRecord): string {
  const firm = record.firm?.[0];
  if (firm !== undefined) return firm;
  const signals = (record.signals ?? {}) as Record<string, number>;
  const ranked = GATE_SIGNALS.map((name) => [name, signals[name] ?? 0] as const)
    .filter(([name]) => name !== "in_scope")
    .sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? "(unknown)";
}

export function calibrateReport(config: HookConfig, store: Store): string {
  const log = store.readLog();
  const pre = log.filter((r) => r.event === "PreToolUse");
  const judged = pre.filter((r) => r.signals !== undefined && r.signals.destructive !== undefined);
  const decisions = (...names: string[]): DecisionRecord[] => log.filter((r) => names.includes(r.decision ?? ""));

  const notes = decisions("note");
  const suppressed = pre.filter((r) => typeof r.suppressed === "string");
  const trips = decisions("trip");
  const repeats = decisions("trip-repeat");
  const reissues = decisions("reissue");
  const affirms = decisions("affirm");
  const prompts = log.filter((r) => r.event === "UserPromptSubmit" && r.decision === "prompt");

  const lines = ["jev — calibration report", ""];

  // ------------------------------------------------ 1. agent-facing output
  lines.push(
    "1. What Claude was told",
    `  gate decisions judged by the model: ${judged.length}`,
    `  tripwires from a code pattern (no model): ${
      trips.filter((r) => r.source === "pattern").length
    }`,
    `  notes emitted: ${notes.length}`,
    "  suppressed, by reason:",
    formatTally(tally(suppressed.map((r) => r.suppressed as string))),
    "  notes by driving signal:",
    formatTally(tally(notes.map((record) => driver(record)))),
  );
  if (prompts.length > 0) {
    // Notes are attributed to the prompt window they fell in: the counter that
    // enforces the cap resets on UserPromptSubmit, and so does this.
    const boundaries = prompts
      .map((record) => Date.parse(record.ts ?? ""))
      .filter((ts) => Number.isFinite(ts))
      .sort((a, b) => a - b);
    const perPrompt = boundaries.map((start, index) => {
      const end = boundaries[index + 1] ?? Number.POSITIVE_INFINITY;
      return notes.filter((note) => {
        const ts = Date.parse(note.ts ?? "");
        return Number.isFinite(ts) && ts >= start && ts < end;
      }).length;
    });
    const mean = perPrompt.reduce((a, b) => a + b, 0) / perPrompt.length;
    lines.push(
      `  notes per user prompt: mean ${mean.toFixed(2)}, max ${Math.max(...perPrompt)} (cap ${MAX_NOTES_PER_PROMPT}, ${perPrompt.length} prompts)`,
    );
  } else {
    lines.push("  notes per user prompt: no prompts recorded yet");
  }

  // ------------------------------------------------------------ 2. tripwire
  const tripById = new Map(trips.filter((r) => r.trip_id !== undefined).map((r) => [r.trip_id as string, r]));
  const reissuedIds = new Set(reissues.map((r) => r.trip_id).filter((id): id is string => id !== undefined));
  const affirmedIds = new Set(affirms.map((r) => r.trip_id).filter((id): id is string => id !== undefined));
  const repeatsById = tally(repeats.map((r) => r.trip_id ?? "(unknown)"));
  const stuck = [...repeatsById.entries()].filter(([, count]) => count >= 2);
  const ranIds = new Set(decisions("reissue-ran").map((r) => r.trip_id));
  const failedIds = new Set(decisions("reissue-failed").map((r) => r.trip_id));
  const notReissued = [...tripById.keys()].filter((id) => !reissuedIds.has(id));
  const gaps: number[] = [];
  for (const reissue of reissues) {
    const trip = reissue.trip_id === undefined ? undefined : tripById.get(reissue.trip_id);
    if (trip === undefined) continue;
    const from = Date.parse(trip.ts ?? "");
    const to = Date.parse(reissue.ts ?? "");
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from) gaps.push(to - from);
  }

  lines.push(
    "",
    "2. Tripwires",
    `  opened: ${trips.length}   repeats: ${repeats.length}   re-issued: ${reissuedIds.size}   not re-issued: ${notReissued.length}`,
    "  by source:",
    formatTally(tally(trips.map((r) => r.source ?? "(unknown)"))),
  );
  const patternTrips = trips.filter((r) => r.source === "pattern");
  if (patternTrips.length > 0) {
    lines.push("  by code rule:", formatTally(tally(patternTrips.map((r) => r.prefilter ?? "(unknown)"))));
  }
  const modelTrips = trips.filter((r) => r.source === "model");
  if (modelTrips.length > 0) {
    lines.push("  by top signal (model trips):", formatTally(tally(modelTrips.map((record) => driver(record)))));
  }
  lines.push(
    `  re-issues that ran: ${ranIds.size}, that failed: ${failedIds.size}`,
    `  affirmed but never re-issued: ${[...affirmedIds].filter((id) => !reissuedIds.has(id)).length}`,
    `  median trip → re-issue: ${gaps.length === 0 ? "(none)" : `${Math.round(median(gaps) / 1000)}s`}`,
  );
  if (stuck.length > 0) {
    lines.push(
      `  stuck (3+ denies of the same call): ${stuck.length} — ${stuck.map(([id, n]) => `${id} ×${n + 1}`).join(", ")}`,
      "  A deny loop is reported, not capped: a cap that went silent would be a bypass.",
    );
  }

  // ----------------------------------------------------- 3. marker hygiene
  lines.push(
    "",
    "3. Marker hygiene",
    `  markers on calls that were never tripped: ${decisions("marker-unmatched").length}`,
    `  markers too short to count as a reason: ${decisions("marker-short").length}`,
    `  sidecar affirmations naming an unknown trip: ${decisions("affirm-unmatched").length}`,
    "  The first line is the reflex metric: a marker only ever answers a specific tripwire.",
  );

  // Section 4 is about gate signals, so it needs gate judgments. Section 5
  // replays four events and only 5a is the gate's, so it runs either way; and
  // section 6 is worth reading whether or not the model was ever called.
  const buckets: [string, DecisionRecord[]][] = [
    ["note", judged.filter((r) => r.decision === "note")],
    ["trip", judged.filter((r) => r.decision === "trip")],
    ["silent", judged.filter((r) => r.decision === "allow" || (r.decision ?? "").startsWith("silent-"))],
  ];

  // ----------------------------------------- 4. histograms, split by outcome
  lines.push("", "4. Signal distributions, by what the gate did");
  if (judged.length === 0) {
    lines.push("  Nothing judged by the model yet. Run a few sessions with gate=advisory and try again.");
  }
  for (const [name, records] of judged.length === 0 ? [] : buckets) {
    lines.push(`  ${name} (${records.length})`);
    if (records.length === 0) {
      lines.push("    (no samples)");
      continue;
    }
    for (const name of [...GATE_SIGNALS, ...SCOPE_SIGNALS]) {
      const values = records.map((r) => signal(r, name)).filter((n): n is number => n !== undefined);
      // A 0.5.0-only signal is simply absent from an older record; a row of
      // "(no samples)" for every one of them would be noise on an old log.
      if (values.length === 0 && (SCOPE_SIGNALS as readonly string[]).includes(name)) continue;
      lines.push(`    ${name.padEnd(20)} ${histogram(values)}`);
    }
    const blast = records.map((r) => signal(r, "blast_radius")).filter((n): n is number => n !== undefined);
    if (blast.length > 0) {
      const mean = blast.reduce((a, b) => a + b, 0) / blast.length;
      lines.push(`    blast_radius         mean ${mean.toFixed(2)} of 3, p95 ${percentile(blast, 95).toFixed(2)}`);
    }
    // `same_task_area` is logged and not consumed in 0.5.0. It is a
    // corroborator for `scope_step`, and this line is the evidence for
    // promoting it to policy, or for dropping it.
    const pairs = records
      .map((r) => [signal(r, "same_task_area"), signal(r, "scope_step")] as const)
      .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined);
    if (pairs.length > 0) {
      const agree = pairs.filter(([area, step]) => area >= 0.5 === step >= 0.5).length;
      lines.push(
        `    same_task_area agrees with scope_step on ${agree}/${pairs.length} (both read at 0.5)`,
      );
    }
  }

  // --------------------------------------------------- 5. threshold replay
  const stops = log.filter((r) => (r.event === "Stop" || r.event === "SubagentStop") && r.signals !== undefined);
  const screens = log.filter((r) => r.event === "PostToolUse" && signal(r, "injection") !== undefined);
  const kinds = log.filter((r) => r.event === "UserPromptSubmit" && signal(r, "kind_confidence") !== undefined);

  lines.push("", "5. Replay at other thresholds, over your own log");

  const outputsNow = judged.filter((r) => r.decision === "note" || r.decision === "trip").length;
  lines.push(`  5a gate (currently auto ${config.autoThreshold}; ${outputsNow} notes+trips of ${judged.length})`);
  if (judged.length === 0) {
    lines.push("    no records");
  } else {
    for (const auto of [0.75, 0.8, 0.85, 0.9, 0.95]) {
      let noted = 0;
      let tripped = 0;
      for (const record of judged) {
        const outcome = replayGate(record, auto, config.reviewThreshold);
        if (outcome === "note") noted += 1;
        if (outcome === "trip") tripped += 1;
      }
      const total = noted + tripped;
      const delta = outputsNow === 0 ? 0 : Math.round(((outputsNow - total) / outputsNow) * 100);
      // A zero delta is "0%", not "-0%".
      const change = delta === 0 ? "0%" : `${delta > 0 ? "-" : "+"}${Math.abs(delta)}%`;
      lines.push(`    auto ${auto.toFixed(2)}: ${noted} notes + ${tripped} trips = ${total} (${change} vs now)`);
    }
    lines.push(
      "    Exact for the table's rows; the per-session duplicate check and the five-note",
      "    cap are session state rather than log state, so the replay counts before them.",
    );
  }

  lines.push(`  5b stop (${stops.length} judged)`);
  if (stops.length === 0) {
    lines.push("    no records");
  } else {
    for (const auto of [0.75, 0.8, 0.85, 0.9, 0.95]) {
      const blocks = stops.filter((record) => replayStop(record, auto) === "block").length;
      lines.push(`    auto ${auto.toFixed(2)}: ${blocks} blocks of ${stops.length}`);
    }
    lines.push(
      "    The unfinished rule only. The verification-ledger rule compares a claim against",
      "    what the last check command did, which is session state and not in this log.",
    );
  }

  lines.push(`  5c screen (${screens.length} judged)`);
  if (screens.length === 0) {
    lines.push("    no records");
  } else {
    for (const auto of [0.75, 0.8, 0.85, 0.9, 0.95]) {
      const flagged = screens.filter((record) => replayScreen(record, auto) === "flagged").length;
      const contradicts = screens.filter((record) => replayScreen(record, auto) === "contradicts").length;
      lines.push(`    auto ${auto.toFixed(2)}: ${flagged} flagged + ${contradicts} contradictions of ${screens.length}`);
    }
  }

  lines.push(`  5d prompt kind (currently confidence ${config.confidenceThreshold}; ${kinds.length} judged)`);
  if (kinds.length === 0) {
    lines.push("    no records — route_prompts is off unless you turned it on");
  } else {
    for (const confidence of [0.6, 0.7, 0.8, 0.85, 0.9, 0.95]) {
      const printed = kinds.filter((record) => replayKind(record, confidence) === "printed").length;
      lines.push(`    confidence ${confidence.toFixed(2)}: ${printed} printed of ${kinds.length}`);
    }
  }

  return [...lines, "", ...evidenceSection(tripById, notReissued, reissues, affirms)].join("\n");
}

/**
 * Section 6: what each kind of record is worth as evidence.
 *
 * Printed in the report rather than left to the README because this is where
 * someone decides whether to keep the gate on, and the honest ordering is not
 * obvious: the strongest thing the plugin can show is a trip the agent could
 * have answered with one line and did not.
 */
function evidenceSection(
  tripById: Map<string, DecisionRecord>,
  notReissued: string[],
  reissues: DecisionRecord[],
  affirms: DecisionRecord[],
): string[] {
  const unansweredModelTrips = notReissued.filter((id) => tripById.get(id)?.source === "model").length;
  const lines = [
    "6. How to read this",
    "  A pattern trip is certain by construction: a code rule matched and no model ran.",
    `  A model trip that was NOT re-issued (${unansweredModelTrips}) is the strongest`,
    "  evidence available that this gate changed what happened — the agent saw the",
    "  reason, had a marker available, and chose something else.",
    "  A re-issued trip is auditable by its marker text, below.",
    "  A note is post-hoc by construction: it arrives with the tool result, after the",
    "  call ran, so it can only inform the next step.",
    "  Nothing here measures correctness. Nobody was prompted, so there is no human",
    "  verdict to score against.",
  ];
  // A sidecar affirmation and the re-issue it let through carry the same text,
  // so the same sentence is not printed twice.
  const seen = new Set<string>();
  const recentAffirmations = [...affirms, ...reissues]
    .filter((r) => r.affirmation !== undefined)
    .reverse()
    .filter((r) => {
      const key = `${r.trip_id ?? "?"}|${r.affirmation}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
  if (recentAffirmations.length > 0) {
    lines.push("", "  Newest marker texts (redacted, as the agent wrote them):");
    for (const record of recentAffirmations) {
      lines.push(`    ${record.trip_id ?? "?"}  ${record.affirmation}`);
    }
  }
  return lines;
}
