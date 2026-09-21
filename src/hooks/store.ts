/**
 * On-disk state for the hooks: one small JSON file per session, plus an
 * append-only decision log.
 *
 * Everything here is best-effort. A hook that cannot write its bookkeeping
 * still has to let the session proceed, so every method swallows its own I/O
 * errors rather than propagating them into the handler.
 *
 * The session file exists because a hook fires with a tool call, not with the
 * user's request. `transcript_path` is documented as "conversation JSON" with
 * no schema and is written asynchronously, so parsing it would be guessing at a
 * private format; the UserPromptSubmit hook records the prompt instead and
 * every other handler reads it from here.
 */

import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SessionConfig } from "./daemon/registry.js";
import { liveTrips, MAX_TRIPS, readTrip, type Trip, type TripSource } from "./tripwire.js";
import { VERIFICATION_KINDS, type VerificationLedger } from "./verification.js";

/** Maximum substantive prompts kept per session, oldest first. */
export const MAX_PROMPTS = 3;
export const MAX_PROMPT_CHARS = 2000;
/**
 * Below this a prompt is a continuation — "go", "ship both", "try it now". It
 * is kept, because "make it public" is an authorization the gate should see,
 * but it carries almost no scope and must not evict the request it continues.
 */
export const SHORT_PROMPT_CHARS = 40;
export const MAX_SHORT_PROMPTS = 2;

/**
 * Append a prompt, trimming short and substantive prompts separately. Order is
 * preserved.
 *
 * An identical consecutive prompt is dropped. In 0.4.0 `UserPromptSubmit` has
 * both an http entry and a command fallback, and the fallback is supposed to
 * notice the daemon answered and exit — but if it ever double-fires, the only
 * visible effect should be nothing at all, rather than the same sentence
 * occupying two of the three prompt slots and evicting the request before it.
 */
export function nextPrompts(existing: readonly string[], prompt: string): string[] {
  const text = prompt.trim();
  if (text === "") return [...existing];
  if (existing[existing.length - 1] === text) return [...existing];
  const all = [...existing, text];
  const isShort = (p: string): boolean => p.length < SHORT_PROMPT_CHARS;
  let short = all.filter(isShort).length;
  let long = all.length - short;
  return all.filter((p) => {
    if (isShort(p)) {
      if (short > MAX_SHORT_PROMPTS) {
        short -= 1;
        return false;
      }
      return true;
    }
    if (long > MAX_PROMPTS) {
      long -= 1;
      return false;
    }
    return true;
  });
}

/**
 * The user's request as one string within `max` characters. The budget is
 * filled from the newest prompt backwards, so what gets cut is the oldest
 * context and never the instruction the user just gave.
 */
export function requestText(prompts: readonly string[], max: number, separator = "\n---\n"): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = prompts.length - 1; i >= 0; i -= 1) {
    const prompt = prompts[i] as string;
    const cost = prompt.length + (kept.length > 0 ? separator.length : 0);
    if (used + cost > max) {
      if (kept.length === 0) kept.unshift(prompt.slice(0, max));
      break;
    }
    kept.unshift(prompt);
    used += cost;
  }
  return kept.join(separator);
}
/** Rotate the decision log at this size. One generation is kept. */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** Session files older than this are pruned. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Pending re-issue correlations kept per session. */
const MAX_PENDING = 20;
/** Noted fingerprints kept per session, for the duplicate check. */
const MAX_NOTED = 40;

export interface PendingReissue {
  tool_use_id: string;
  ts: number;
  tool_name: string;
  /** The trip the re-issue answered, when one is known. */
  trip_id?: string;
}

/** One fingerprint this session has already handed the agent a note about. */
export interface NotedAction {
  fingerprint: string;
  ts: number;
}

/** Subagent spawns kept per session. Parallel fan-out is rarely wider. */
export const MAX_SUBAGENT_TASKS = 8;
/** A spawn recorded and never consumed stops standing in for a request. */
export const SUBAGENT_TASK_TTL_MS = 30 * 60 * 1000;

/**
 * The task a subagent was given, captured from the parent's `Agent` spawn.
 *
 * It exists because a tool call made inside a subagent is scored against the
 * *user's* prompts today, and the subagent is not doing what the user last
 * asked for — it is doing what the parent told it to. Four of the five model
 * trips in the first live week were that mistake. The prompt here is the
 * parent's own text, not a file and not a tool result.
 */
export interface SubagentTask {
  agent_type: string;
  /** Redacted and clamped by the caller. */
  prompt: string;
  ts: number;
}

/** Live spawns, expired ones dropped. */
export function liveSubagentTasks(tasks: readonly SubagentTask[], now: number): SubagentTask[] {
  return tasks.filter((task) => now - task.ts <= SUBAGENT_TASK_TTL_MS);
}

export interface SessionState {
  /** Last few user prompts, oldest first, each truncated. */
  prompts: string[];
  /** Stop blocks issued since the last user prompt. */
  stop_blocks: number;
  /** `/jev:off` for this session. */
  disabled?: boolean;
  /**
   * Calls this plugin tripped and then let through after an affirmation,
   * awaiting the PostToolUse that says whether they ran.
   */
  pending_reissues?: PendingReissue[];
  /**
   * Open tripwires. Deliberately NOT reset by a new user prompt: a trip issued
   * a moment before the user types "yes, do it" must still be affirmable.
   */
  trips?: Trip[];
  /**
   * Tasks handed to subagents that have not stopped yet. Deliberately NOT
   * reset by a new user prompt: a subagent spawned before the user typed is
   * still working on what the parent told it to do.
   */
  subagent_tasks?: SubagentTask[];
  /** Notes emitted since the last user prompt, for the per-prompt cap. */
  notes_this_prompt?: number;
  /** Fingerprints already noted, for the duplicate check. */
  noted?: NotedAction[];
  /** SessionStart already told the user the key is missing. */
  key_warned?: boolean;
  /**
   * The non-secret configuration snapshot this session posted to the daemon.
   *
   * Written so a *replaced* daemon — a plugin update, a crash, a
   * `/jev:daemon restart` — can answer a hook for a session it never saw hello
   * from with that session's settings rather than with its own environment's.
   */
  config?: SessionConfig;
  /**
   * What the last test/build/type-check/lint run established, and how many
   * edits have happened since. Deliberately NOT reset by a new user prompt:
   * a failing test suite is still failing after the user types something.
   */
  verification?: VerificationLedger;
  /** Epoch ms of the last write, for pruning. */
  updated?: number;
}

export const EMPTY_SESSION: SessionState = { prompts: [], stop_blocks: 0 };

export interface DecisionRecord {
  ts: string;
  session_id: string;
  event: string;
  tool_name?: string;
  tool_use_id?: string;
  /** Redacted, <= 300 chars. */
  subject?: string;
  prefilter?: string;
  signals?: Record<string, number>;
  /**
   * Policy options in force, so `/jev:calibrate` can replay the decision.
   *
   * Open-ended from 0.5.0: four events log a policy now, and pinning the
   * shape here meant a handler that recorded one more switch had to widen a
   * type in another module before the replay could read it.
   */
  policy?: Record<string, string | number | boolean>;
  /**
   * The thresholds the decision was actually made at, on every judged record.
   * Without them a replay has to assume the ones configured *now*, which is
   * wrong for exactly the log a threshold change is being judged on.
   */
  thresholds?: { auto: number; review: number; confidence: number };
  decision: string;
  reasons?: string[];
  /** 16 hex of the canonical action, so a trip and its re-issue can be paired. */
  fingerprint?: string;
  trip_id?: string;
  source?: TripSource;
  /** How the text reached its audience. `deny` and `ask` are pre-execution. */
  channel?: "note" | "deny" | "ask";
  /** The exact text handed to the agent, redacted and clamped. */
  emitted?: string;
  /** The agent's stated reason for a re-issue, redacted and clamped. */
  affirmation?: string;
  /** Why a note that the table called for was not emitted. */
  suppressed?: string;
  /** The firm reasons behind a note or a trip, in priority order. */
  firm?: string[];
  /** Gate: whether `wide` was decided on level probabilities or the expectation. */
  blast_source?: "probabilities" | "expectation";
  /**
   * Gate: what stood in for the user's request. `subagent_task` is the task a
   * parent handed this subagent; `none` means scope was ignored.
   */
  scope_source?: "prompts" | "subagent_task" | "none";
  /**
   * The `agent_type` this judgment happened inside, when it happened inside
   * one. Logged on every judged record so the subagent share of the gate's
   * output is measurable rather than a guess.
   */
  subagent?: string;
  /** Stop: which of the three unfinished Nouls fired. */
  unfinished_by?: string;
  /** PostToolUse: how the result was chunked, and how much of it was judged. */
  chunks_total?: number;
  chunks_judged?: number;
  chunks_failed?: number;
  /** Which 0.6.0 subsystem wrote this record; absent means the gate. */
  kind?: "gate" | "lint" | "commit" | "claims";
  /** lint/commit: the firm finding ids (conventions as `conv:<text>`). */
  findings?: string[];
  /** lint/commit: the redacted relative path of the edited file. */
  file?: string;
  /** Stop claims: the counts and the newest few items. */
  claims?: {
    extracted: number;
    fabricated: number;
    contradicted: number;
    supported: number;
    not_addressed: number;
    unlocated: number;
    items: { claim: string; verdict: string; p?: number | undefined }[];
  };
  model?: string;
  latency_ms?: number;
  input_tokens?: number;
  /**
   * The daemon answered this from its in-memory cache: no call went out, so
   * `latency_ms` and `input_tokens` are both 0 and mean it.
   */
  memo?: boolean;
  error?: string;
}

/**
 * The cost fields of a record, from a model result.
 *
 * One helper rather than four copies of the same three lines, because 0.4.0
 * added a fourth field — `memo` — and a handler that forgot it would report a
 * cached answer as a 0 ms, 0 token real call, which is the one thing the memo
 * must never be allowed to do to the log.
 */
export function modelCost(result: {
  model: string;
  latency_ms: number;
  usage: { input_tokens: number };
  memo?: boolean;
}): Pick<DecisionRecord, "model" | "latency_ms" | "input_tokens" | "memo"> {
  return {
    model: result.model,
    latency_ms: result.latency_ms,
    input_tokens: result.usage.input_tokens,
    ...(result.memo === true ? { memo: true } : {}),
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Validate a ledger read back off disk.
 *
 * The session file is state this plugin wrote, but it is still a file on disk
 * that anything could have edited, and `last.kind` reaches a user-visible
 * message. Anything unrecognized is dropped rather than repaired.
 */
function readLedger(raw: unknown): VerificationLedger | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Partial<VerificationLedger>;
  const ledger: VerificationLedger = {
    edits_since: typeof value.edits_since === "number" && value.edits_since >= 0 ? Math.floor(value.edits_since) : 0,
  };
  const last = value.last;
  if (
    typeof last === "object" &&
    last !== null &&
    (VERIFICATION_KINDS as readonly string[]).includes(last.kind) &&
    typeof last.ok === "boolean" &&
    typeof last.ts === "number" &&
    typeof last.command === "string"
  ) {
    ledger.last = { kind: last.kind, ok: last.ok, ts: last.ts, command: last.command };
  }
  return ledger;
}

/** Session ids arrive from the harness; never let one escape the data dir. */
export function safeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120);
  return cleaned === "" ? "unknown" : cleaned;
}

/**
 * The marketplace was renamed from `brainwires-jev` to `brainwires-jevwire`
 * after 0.4.0, which moves the plugin's data directory (Claude Code derives it
 * from `<plugin>@<marketplace>`). Copy the old directory into the new one
 * exactly once, so `/jev:calibrate` keeps its history. Only when the new
 * directory has no log yet: this never overwrites anything.
 */
export const LEGACY_DATA_DIR_NAMES: Record<string, string> = { "jev-brainwires-jevwire": "jev-brainwires-jev" };

export function migrateLegacyDataDir(dir: string): boolean {
  const legacyName = LEGACY_DATA_DIR_NAMES[basename(dir)];
  if (legacyName === undefined) return false;
  const legacy = join(dirname(dir), legacyName);
  if (!existsSync(join(legacy, "decisions.jsonl"))) return false;
  if (existsSync(join(dir, "decisions.jsonl"))) return false;
  return safe(() => {
    mkdirSync(dir, { recursive: true });
    for (const entry of ["decisions.jsonl", "decisions.1.jsonl", "sessions", "last-prune"]) {
      const from = join(legacy, entry);
      if (existsSync(from)) cpSync(from, join(dir, entry), { recursive: true, errorOnExist: false, force: false });
    }
    return true;
  }, false);
}

export class Store {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    migrateLegacyDataDir(dir);
  }

  private ensureDir(sub?: string): string {
    const target = sub === undefined ? this.dir : join(this.dir, sub);
    safe(() => mkdirSync(target, { recursive: true }), undefined);
    return target;
  }

  private sessionPath(sessionId: string): string {
    return join(this.dir, "sessions", `${safeSessionId(sessionId)}.json`);
  }

  get logPath(): string {
    return join(this.dir, "decisions.jsonl");
  }

  /** The `/jev:off` fallback when a command cannot learn the session id. */
  get globalDisablePath(): string {
    return join(this.dir, "disabled");
  }

  readSession(sessionId: string): SessionState {
    return safe(() => {
      const raw = readFileSync(this.sessionPath(sessionId), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) return { ...EMPTY_SESSION };
      const state = parsed as Partial<SessionState>;
      const session: SessionState = {
        prompts: Array.isArray(state.prompts) ? state.prompts.filter((p) => typeof p === "string") : [],
        stop_blocks: typeof state.stop_blocks === "number" ? state.stop_blocks : 0,
      };
      if (state.disabled === true) session.disabled = true;
      if (state.key_warned === true) session.key_warned = true;
      // Kept opaque here and validated field by field where it is used
      // (`readSessionConfig`), which is the only place that knows what a
      // sensible value for each setting is.
      if (typeof state.config === "object" && state.config !== null && !Array.isArray(state.config)) {
        session.config = state.config;
      }
      if (Array.isArray(state.pending_reissues)) {
        session.pending_reissues = state.pending_reissues.filter(
          (p): p is PendingReissue => typeof p === "object" && p !== null && typeof p.tool_use_id === "string",
        );
      }
      // Trips reach user-visible text and a `deny` reason, so every field is
      // validated rather than trusted, and expired ones never come back at all.
      if (Array.isArray(state.trips)) {
        const trips = state.trips.map((raw) => readTrip(raw)).filter((trip): trip is Trip => trip !== undefined);
        if (trips.length > 0) session.trips = trips.slice(-MAX_TRIPS);
      }
      // A task's prompt reaches the Jev API as the request a call is judged
      // against, so every field is validated rather than trusted.
      if (Array.isArray(state.subagent_tasks)) {
        const tasks = state.subagent_tasks.filter(
          (task): task is SubagentTask =>
            typeof task === "object" &&
            task !== null &&
            typeof task.agent_type === "string" &&
            typeof task.prompt === "string" &&
            typeof task.ts === "number",
        );
        if (tasks.length > 0) session.subagent_tasks = tasks.slice(-MAX_SUBAGENT_TASKS);
      }
      if (typeof state.notes_this_prompt === "number" && state.notes_this_prompt >= 0) {
        session.notes_this_prompt = Math.floor(state.notes_this_prompt);
      }
      if (Array.isArray(state.noted)) {
        const noted = state.noted.filter(
          (n): n is NotedAction =>
            typeof n === "object" && n !== null && typeof n.fingerprint === "string" && typeof n.ts === "number",
        );
        if (noted.length > 0) session.noted = noted.slice(-MAX_NOTED);
      }
      if (typeof state.updated === "number") session.updated = state.updated;
      const ledger = readLedger(state.verification);
      if (ledger !== undefined) session.verification = ledger;
      return session;
    }, { ...EMPTY_SESSION });
  }

  writeSession(sessionId: string, state: SessionState, now: number = Date.now()): void {
    this.ensureDir("sessions");
    safe(() => {
      writeFileSync(this.sessionPath(sessionId), `${JSON.stringify({ ...state, updated: now })}\n`, "utf8");
    }, undefined);
  }

  updateSession(sessionId: string, mutate: (state: SessionState) => SessionState, now: number = Date.now()): SessionState {
    const next = mutate(this.readSession(sessionId));
    this.writeSession(sessionId, next, now);
    return next;
  }

  /** Session-scoped or global `/jev:off`. */
  isDisabled(sessionId: string): boolean {
    if (safe(() => existsSync(this.globalDisablePath), false)) return true;
    return this.readSession(sessionId).disabled === true;
  }

  setDisabled(sessionId: string | null, disabled: boolean): { scope: "session" | "global"; path: string } {
    if (sessionId === null) {
      this.ensureDir();
      if (disabled) {
        safe(() => writeFileSync(this.globalDisablePath, `${new Date().toISOString()}\n`, "utf8"), undefined);
      } else {
        safe(() => unlinkSync(this.globalDisablePath), undefined);
      }
      return { scope: "global", path: this.globalDisablePath };
    }
    this.updateSession(sessionId, (state) => {
      const next: SessionState = { ...state };
      if (disabled) next.disabled = true;
      else delete next.disabled;
      return next;
    });
    // An enable must also clear a global flag, or it silently does nothing.
    if (!disabled) safe(() => unlinkSync(this.globalDisablePath), undefined);
    return { scope: "session", path: this.sessionPath(sessionId) };
  }

  /** Record that a re-issue was let through, so PostToolUse can see it ran. */
  rememberReissue(sessionId: string, pending: PendingReissue): void {
    this.updateSession(sessionId, (state) => ({
      ...state,
      pending_reissues: [...(state.pending_reissues ?? []), pending].slice(-MAX_PENDING),
    }));
  }

  /** Consume a pending re-issue. Returns it when this call was one of ours. */
  takeReissue(sessionId: string, toolUseId: string): PendingReissue | undefined {
    const state = this.readSession(sessionId);
    const pending = state.pending_reissues ?? [];
    const found = pending.find((p) => p.tool_use_id === toolUseId);
    if (found === undefined) return undefined;
    this.writeSession(sessionId, {
      ...state,
      pending_reissues: pending.filter((p) => p.tool_use_id !== toolUseId),
    });
    return found;
  }

  // ----------------------------------------------------------- subagent tasks

  /** Record the task a parent just handed a subagent. */
  rememberSubagentTask(sessionId: string, task: SubagentTask, now: number = Date.now()): void {
    this.updateSession(
      sessionId,
      (state) => ({
        ...state,
        subagent_tasks: [...liveSubagentTasks(state.subagent_tasks ?? [], now), task].slice(-MAX_SUBAGENT_TASKS),
      }),
      now,
    );
  }

  /**
   * The live task for this agent type, when there is exactly one.
   *
   * Reads without consuming — a subagent makes many tool calls and every one
   * of them is judged against the same task; `SubagentStop` is what removes
   * it. Two live tasks of the same type means two same-type subagents are
   * running in parallel and nothing here can say which one is calling, so the
   * answer is "unknown" rather than a guess: the caller then ignores scope
   * instead of judging against the wrong task.
   */
  takeSubagentTask(sessionId: string, agentType: string, now: number = Date.now()): SubagentTask | undefined {
    const matching = liveSubagentTasks(this.readSession(sessionId).subagent_tasks ?? [], now).filter(
      (task) => task.agent_type === agentType,
    );
    return matching.length === 1 ? matching[0] : undefined;
  }

  /** The subagent stopped: its task is no longer anybody's request. */
  dropSubagentTask(sessionId: string, agentType: string, now: number = Date.now()): void {
    this.updateSession(
      sessionId,
      (state) => {
        const remaining = liveSubagentTasks(state.subagent_tasks ?? [], now).filter(
          (task) => task.agent_type !== agentType,
        );
        const next: SessionState = { ...state };
        if (remaining.length > 0) next.subagent_tasks = remaining;
        else delete next.subagent_tasks;
        return next;
      },
      now,
    );
  }

  // --------------------------------------------------------------- tripwires

  /** Open tripwires, expired ones dropped. */
  liveTrips(sessionId: string, now: number = Date.now()): Trip[] {
    return liveTrips(this.readSession(sessionId).trips ?? [], now);
  }

  /**
   * The open trip for this exact action, if there is one.
   *
   * Exact fingerprint, deliberately: an affirmation answers one action, not a
   * family of them, so an edited re-issue is a new judgment.
   */
  findTripByFingerprint(sessionId: string, fingerprint: string, now: number = Date.now()): Trip | undefined {
    return this.liveTrips(sessionId, now).find((trip) => trip.fingerprint === fingerprint);
  }

  /** The open trip with this id, for the sidecar affirmation form. */
  findTripById(sessionId: string, tripId: string, now: number = Date.now()): Trip | undefined {
    return this.liveTrips(sessionId, now).find((trip) => trip.id === tripId);
  }

  /** Write a new trip, replacing any expired one for the same action. */
  openTrip(sessionId: string, trip: Trip, now: number = Date.now()): Trip {
    this.updateSession(
      sessionId,
      (state) => ({
        ...state,
        trips: [...liveTrips(state.trips ?? [], now).filter((t) => t.fingerprint !== trip.fingerprint), trip].slice(
          -MAX_TRIPS,
        ),
      }),
      now,
    );
    return trip;
  }

  /** Count one more deny against an open trip, and return the new count. */
  repeatTrip(sessionId: string, tripId: string, now: number = Date.now()): number {
    let denies = 1;
    this.updateSession(
      sessionId,
      (state) => ({
        ...state,
        trips: liveTrips(state.trips ?? [], now).map((trip) => {
          if (trip.id !== tripId) return trip;
          denies = trip.denies + 1;
          return { ...trip, denies };
        }),
      }),
      now,
    );
    return denies;
  }

  /** Record a sidecar affirmation against an open trip. */
  affirmTrip(sessionId: string, tripId: string, affirmation: string, now: number = Date.now()): void {
    this.updateSession(
      sessionId,
      (state) => ({
        ...state,
        trips: liveTrips(state.trips ?? [], now).map((trip) =>
          trip.id === tripId ? { ...trip, affirmed_at: now, affirmation } : trip,
        ),
      }),
      now,
    );
  }

  /** Close a trip: it was answered and the call went through. */
  closeTrip(sessionId: string, tripId: string, now: number = Date.now()): void {
    this.updateSession(
      sessionId,
      (state) => ({
        ...state,
        trips: liveTrips(state.trips ?? [], now).filter((trip) => trip.id !== tripId),
      }),
      now,
    );
  }

  /** Remember that a note went out, for the duplicate check and the cap. */
  noteEmitted(sessionId: string, fingerprint: string, now: number = Date.now()): void {
    this.updateSession(
      sessionId,
      (state) => ({
        ...state,
        notes_this_prompt: (state.notes_this_prompt ?? 0) + 1,
        noted: [...(state.noted ?? []).filter((n) => n.fingerprint !== fingerprint), { fingerprint, ts: now }].slice(
          -MAX_NOTED,
        ),
      }),
      now,
    );
  }

  /** Was this exact action noted recently enough that a second note adds nothing? */
  wasNoted(sessionId: string, fingerprint: string, withinMs: number, now: number = Date.now()): boolean {
    return (this.readSession(sessionId).noted ?? []).some(
      (noted) => noted.fingerprint === fingerprint && now - noted.ts <= withinMs,
    );
  }

  /** One `appendFileSync` call, so concurrent hooks cannot interleave a line. */
  append(record: DecisionRecord): void {
    this.ensureDir();
    safe(() => {
      const size = safe(() => statSync(this.logPath).size, 0);
      if (size >= LOG_ROTATE_BYTES) {
        safe(() => renameSync(this.logPath, join(this.dir, "decisions.1.jsonl")), undefined);
      }
      appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, "utf8");
    }, undefined);
  }

  /** Read the log back, newest last. Malformed lines are skipped. */
  readLog(): DecisionRecord[] {
    const files = [join(this.dir, "decisions.1.jsonl"), this.logPath];
    const out: DecisionRecord[] = [];
    for (const file of files) {
      const raw = safe(() => readFileSync(file, "utf8"), "");
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        const parsed = safe<DecisionRecord | null>(() => JSON.parse(line) as DecisionRecord, null);
        if (parsed !== null && typeof parsed === "object") out.push(parsed);
      }
    }
    return out;
  }

  /**
   * Drop session files older than the TTL, at most once a day. Called from
   * UserPromptSubmit, which is the one hook with time to spare.
   */
  pruneSessions(now: number = Date.now()): number {
    const marker = join(this.dir, "last-prune");
    const last = safe(() => Number(readFileSync(marker, "utf8").trim()), 0);
    if (Number.isFinite(last) && now - last < PRUNE_INTERVAL_MS) return 0;
    this.ensureDir();
    safe(() => writeFileSync(marker, String(now), "utf8"), undefined);

    const dir = join(this.dir, "sessions");
    const names = safe(() => readdirSync(dir), [] as string[]);
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      const mtime = safe(() => statSync(path).mtimeMs, now);
      if (now - mtime > SESSION_TTL_MS) {
        safe(() => unlinkSync(path), undefined);
        removed += 1;
      }
    }
    return removed;
  }
}
