/**
 * The agent tripwire: fingerprints, affirmation markers, and the trip record.
 *
 * A classifier trip (model, lint, commit) is a single `deny` addressed to
 * Claude. Nothing about it prompts the user. The agent may re-issue the
 * identical call with an affirmation marker quoting the words of the user's
 * request that require it, and the re-issue passes this hook without further
 * judgment once the quote is found in the user's messages.
 *
 * A code-rule (pattern) trip is not the agent's to clear. Under
 * `pattern_trips: ask`, the default, it is a permission prompt the user
 * answers; under `deny` it is a deny; a marker on either is recorded as
 * refused and the trip stays open. Only `pattern_trips: advisory` makes a
 * pattern trip affirmable like the rest. A marker is something the agent
 * writes, and an agent reading an injected page writes one as easily as it
 * writes `rm -rf ~`.
 *
 * Three properties make the affirmable trips safe enough to be worth having:
 *
 *  1. Since 0.7.2 a marker quotes the user — `# jev:intended "<quote>" <why>`
 *     — and the quote has to be found in one of the user's own messages in
 *     the session transcript (`transcript.ts`, `intent.ts`). A quote nobody
 *     wrote clears nothing. The unquoted 0.7.1 form is accepted on trust only
 *     under `legacy_markers`.
 *  2. The same marked call gets the same answer whether or not a trip is
 *     open, and a marker never skips the judgment: it only answers a trip.
 *     On an untripped call the judgment runs, and a verified marker answers
 *     the trip it raises on the spot; a marker that does not count is refused
 *     with the reason. (Before 0.7.2 a marker on an untripped call was ignored,
 *     so the first call was refused and its identical re-issue accepted.) A
 *     code-rule trip the user owns still outranks any marker.
 *  3. Marker text never reaches Jev. It is removed before the action is built,
 *     so no text in a marker can move `in_scope`.
 *
 * Everything here is pure: no clock, no I/O, no model. `node:crypto` is the
 * only import, which keeps the hook bundle dependency-free.
 */

import { createHash } from "node:crypto";

/** How long a trip can be answered with a marker. */
export const TRIP_TTL_MS = 30 * 60 * 1000;
/** Trips kept per session, newest first on eviction. */
export const MAX_TRIPS = 20;
/**
 * Shortest affirmation that counts as a reason.
 *
 * `# jev:intended yes` is a reflex, not a reason. Twelve characters does not
 * make it a good reason — nothing here can — but it does make "the sentence of
 * the request" the cheaper thing to type than a placeholder, and the text is
 * logged and shown to the user either way.
 */
export const MIN_AFFIRM_CHARS = 12;
/** Longest reason, affirmation, or emitted text kept in state and the log. */
export const MAX_REASON_CHARS = 200;

/**
 * The marker, on the last line of a Bash command.
 *
 * Anchored to the end so that a `#` earlier in the command — inside a URL
 * fragment, a sed script, a commit message — cannot be read as one, and so the
 * marker survives a heredoc: the terminator stays intact on its own line and
 * the marker follows it.
 */
export const MARKER_PATTERN = /(?:^|[ \t])#[ \t]*jev:intended:?[ \t]+(.+?)\s*$/;

/** `# jev:intended t-1a2b3c4d: <reason>` — the sidecar form, for any tool. */
const TRIP_ID_PATTERN = /^(t-[0-9a-f]{8})[ \t]*:[ \t]*(.*)$/;

/** A Bash body that does nothing, which is all a sidecar call may be. */
const SIDECAR_BODIES = new Set(["true", ":"]);

export type TripSource = "pattern" | "model" | "lint" | "commit";

export interface Trip {
  /** `t-` plus the first 8 hex of the fingerprint. */
  id: string;
  fingerprint: string;
  tool_name: string;
  /** Epoch ms of the first deny. */
  ts: number;
  source: TripSource;
  /** The code rule that matched, for a pattern trip. */
  pattern?: string;
  /** Why it tripped, <= MAX_REASON_CHARS, redacted by the caller. */
  reason: string;
  signals?: Record<string, number>;
  /** 1 on creation, +1 for every repeat. */
  denies: number;
  affirmed_at?: number;
  /** The agent's stated reason, redacted and clamped. */
  affirmation?: string;
}

export interface AffirmationMarker {
  /**
   * The reason text, trimmed. Absent when it is shorter than the minimum and
   * carries no quote: a quoted marker is checked against the transcript
   * instead, so a short quote of a short user message (`"yes"`) still counts.
   */
  reason?: string;
  /**
   * `# jev:intended "<quote>" <explanation>`: the words in double quotes,
   * which have to appear in one of the user's own messages. Absent for the
   * legacy unquoted form.
   */
  quote?: string;
  /** Whatever follows the closing quote, trimmed. Absent when empty. */
  explanation?: string;
  /** The trip this marker answers, for the sidecar form. */
  trip_id?: string;
  /** A marker was present but its reason was too short to count. */
  short: boolean;
}

/** `"…"` or `“…”` at the start of a marker's reason, and the rest. */
const QUOTE_PATTERN = /^["\u201c]([^"\u201d]*)["\u201d][ \t]*(.*)$/;

/**
 * Split a marker reason into its quote and explanation.
 *
 * Only a reason that *starts* with a double quote and closes it has a quote.
 * An unclosed or empty quote is no quote at all, which the handler refuses in
 * verified mode the same way it refuses the unquoted form.
 */
export function splitQuote(reason: string): { quote: string; explanation?: string } | undefined {
  const match = QUOTE_PATTERN.exec(reason);
  if (match === null) return undefined;
  const quote = (match[1] ?? "").trim();
  if (quote === "") return undefined;
  const explanation = (match[2] ?? "").trim();
  return explanation === "" ? { quote } : { quote, explanation };
}

/**
 * Parse the marker off the last line of a command. Pure, and quote-blind.
 *
 * "The last line" is the last line with anything on it: a command that ends in
 * a newline (a heredoc-shaped command often does) still carries its marker.
 * Before 0.7.2 the trailing newline made the last line empty, the marker went
 * unread, its text became part of the fingerprint, and the re-issue was told it
 * was "still without a marker" while the marker sat on the line above.
 */
export function parseMarker(command: string): { stripped: string; marker?: AffirmationMarker } {
  const normalized = command.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  const lastBreak = normalized.lastIndexOf("\n");
  const lastLine = normalized.slice(lastBreak + 1);
  const match = MARKER_PATTERN.exec(lastLine);
  if (match === null) return { stripped: command };

  const head = lastLine.slice(0, match.index).replace(/[ \t]+$/, "");
  const body = normalized.slice(0, lastBreak + 1) + head;
  // A marker on a line of its own leaves a trailing newline behind.
  const stripped = head === "" ? normalized.slice(0, Math.max(0, lastBreak)) : body;

  const raw = (match[1] ?? "").trim();
  const withId = TRIP_ID_PATTERN.exec(raw);
  const reason = (withId === null ? raw : (withId[2] ?? "")).trim();
  const quoted = splitQuote(reason);
  const marker: AffirmationMarker = { short: quoted === undefined && reason.length < MIN_AFFIRM_CHARS };
  if (!marker.short) marker.reason = reason;
  if (quoted !== undefined) {
    marker.quote = quoted.quote;
    if (quoted.explanation !== undefined) marker.explanation = quoted.explanation;
  }
  if (withId !== null) marker.trip_id = withId[1] as string;
  return { stripped, marker };
}

/** Is this stripped Bash body the do-nothing call a sidecar affirmation is? */
export function isSidecarBody(command: string): boolean {
  return SIDECAR_BODIES.has(command.trim());
}

/** JSON with keys in a fixed order, so the same input hashes the same way. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

const FILE_FIELDS = [
  "file_path",
  "notebook_path",
  "path",
  "content",
  "old_string",
  "new_string",
  "new_source",
  "edits",
  "cell_id",
  "cell_type",
] as const;

/**
 * The text a fingerprint is taken over.
 *
 * Deliberately exact. Any edit to a tripped call — a changed flag, a different
 * path, a reordered argument — is a different action, and a different action
 * deserves its own judgment rather than inheriting an affirmation. The cost is
 * that a narrowed re-issue is judged again, which is the direction to fail in.
 *
 * `description` is excluded everywhere: it is prose the agent writes about the
 * call, so including it would let a reworded description defeat a trip.
 */
export function canonicalAction(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    return command.replace(/\r\n/g, "\n").trim();
  }

  const fields: Record<string, unknown> = {};
  let sawField = false;
  for (const field of FILE_FIELDS) {
    if (toolInput[field] !== undefined) {
      fields[field] = toolInput[field];
      sawField = true;
    }
  }
  if (sawField) return stableJson(fields);

  const { description: _description, ...rest } = toolInput;
  return stableJson(rest);
}

/** `sha256(tool + NUL + canonical)`, truncated to 16 hex. */
export function fingerprint(toolName: string, toolInput: Record<string, unknown>): string {
  const canonical = canonicalAction(toolName, toolInput);
  return createHash("sha256").update(`${toolName} ${canonical}`).digest("hex").slice(0, 16);
}

/** The id the agent sees and types back in a sidecar marker. */
export function tripIdOf(fingerprintHex: string): string {
  return `t-${fingerprintHex.slice(0, 8)}`;
}

/** Trips still answerable at `now`. */
export function liveTrips(trips: readonly Trip[], now: number): Trip[] {
  return trips.filter((trip) => now - trip.ts <= TRIP_TTL_MS).slice(-MAX_TRIPS);
}

/** Validate one trip read back off disk. Anything unrecognized is dropped. */
export function readTrip(raw: unknown): Trip | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Partial<Trip>;
  if (
    typeof value.id !== "string" ||
    typeof value.fingerprint !== "string" ||
    typeof value.tool_name !== "string" ||
    typeof value.ts !== "number" ||
    !Number.isFinite(value.ts) ||
    (value.source !== "pattern" && value.source !== "model" && value.source !== "lint" && value.source !== "commit")
  ) {
    return undefined;
  }
  const trip: Trip = {
    id: value.id.slice(0, 40),
    fingerprint: value.fingerprint.slice(0, 64),
    tool_name: value.tool_name.slice(0, 120),
    ts: value.ts,
    source: value.source,
    reason: typeof value.reason === "string" ? value.reason.slice(0, MAX_REASON_CHARS) : "",
    denies: typeof value.denies === "number" && value.denies >= 1 ? Math.floor(value.denies) : 1,
  };
  if (typeof value.pattern === "string") trip.pattern = value.pattern.slice(0, 80);
  if (typeof value.affirmed_at === "number" && Number.isFinite(value.affirmed_at)) {
    trip.affirmed_at = value.affirmed_at;
  }
  if (typeof value.affirmation === "string") trip.affirmation = value.affirmation.slice(0, MAX_REASON_CHARS);
  if (typeof value.signals === "object" && value.signals !== null) {
    const signals: Record<string, number> = {};
    for (const [name, probability] of Object.entries(value.signals)) {
      if (typeof probability === "number" && Number.isFinite(probability)) signals[name] = probability;
    }
    if (Object.keys(signals).length > 0) trip.signals = signals;
  }
  return trip;
}
