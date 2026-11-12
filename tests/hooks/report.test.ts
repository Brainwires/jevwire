/**
 * The `/jev:status`, `/jev:why` and `/jev:calibrate` reports.
 *
 * Two properties matter most, and both are negative: the API key never appears
 * in any of them, and nothing in `/jev:calibrate` claims to measure whether a
 * judgment was correct. Nobody is prompted in 0.3, so there is no human verdict
 * to score against, and a report that implied otherwise would be the most
 * expensive kind of wrong.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Health } from "../../src/hooks/daemon/control.js";
import { emptyCounters, type DaemonState } from "../../src/hooks/daemon/state-file.js";
import {
  calibrateReport,
  daemonReport,
  statusReport,
  USD_PER_MTOK,
  whyReport,
  type DaemonView,
} from "../../src/hooks/report.js";
import type { DecisionRecord } from "../../src/hooks/store.js";
import { Store } from "../../src/hooks/store.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    ts: new Date(NOW - 60_000).toISOString(),
    session_id: "s1",
    event: "PreToolUse",
    tool_name: "Bash",
    subject: "Bash {}",
    decision: "note",
    channel: "note",
    firm: ["destructive"],
    emitted: "[jev] The Bash call above (rm -rf build) was scored destructive by the jev classifier (p=0.95).",
    fingerprint: "1111111111111111",
    signals: { destructive: 0.95, outward_facing: 0.02, in_scope: 0.9, credential_exposure: 0.01, blast_radius: 1.2 },
    policy: { ignore_scope: false, uncertain: "risky-lean" },
    reasons: ["The action destroys or overwrites existing data."],
    model: "jev-1.13",
    latency_ms: 240,
    input_tokens: 900,
    ...overrides,
  };
}

/** A code-pattern trip: no model, so no signals and no policy options. */
function patternTrip(prefilter: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const base = record({
    decision: "trip",
    source: "pattern",
    channel: "deny",
    trip_id: "t-aaaaaaaa",
    prefilter,
    reasons: [prefilter],
    emitted: `[jev] tripwire t-aaaaaaaa: this Bash call was not run because it matched the code rule "${prefilter}".`,
    ...overrides,
  });
  delete base.signals;
  delete base.policy;
  delete base.firm;
  return base;
}

/** A judged Stop record, with whichever signals the case is about. */
function stopRecord(signals: Record<string, number>): DecisionRecord {
  return {
    ts: new Date(NOW - 60_000).toISOString(),
    session_id: "s1",
    event: "Stop",
    decision: "allow",
    signals: { claims_complete: 0.5, addresses_request: 0.9, claims_verified: 0.02, ...signals },
  };
}

/** A judged PostToolUse screen. */
function screenRecord(signals: Record<string, number>): DecisionRecord {
  return {
    ts: new Date(NOW - 60_000).toISOString(),
    session_id: "s1",
    event: "PostToolUse",
    tool_name: "WebFetch",
    decision: "clean",
    signals,
  };
}

/** A judged prompt classification. */
function kindRecord(confidence: number): DecisionRecord {
  return {
    ts: new Date(NOW - 60_000).toISOString(),
    session_id: "s1",
    event: "UserPromptSubmit",
    decision: confidence >= 0.85 ? "multi_file_implementation" : "low-confidence",
    signals: { kind_confidence: confidence, ambiguity: 0.4 },
  };
}

function prompt(offsetMs: number): DecisionRecord {
  return {
    ts: new Date(NOW - offsetMs).toISOString(),
    session_id: "s1",
    event: "UserPromptSubmit",
    decision: "prompt",
  };
}

let dir: string;
let store: Store;
beforeEach(() => {
  dir = tempDir();
  store = new Store(dir);
});
afterEach(() => {
  cleanup(dir);
});

describe("statusReport", () => {
  it("says whether a key is configured without printing it", () => {
    const report = statusReport(testConfig(dir, { apiKey: "sk-super-secret" }), store, NOW);
    expect(report).toContain("API key: configured");
    expect(report).not.toContain("sk-super-secret");
  });

  it("says plainly when there is no key", () => {
    expect(statusReport(testConfig(dir, { apiKey: null }), store, NOW)).toContain("not configured");
  });

  it("prints the gate level and whether anything can prompt", () => {
    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("gate: advisory");
    expect(report).toContain("ask_on_trip: false");
    expect(report).toContain("the user is not prompted");
    expect(statusReport(testConfig(dir, { askOnTrip: true }), store, NOW)).toContain("ask_on_trip: true");
  });

  it("counts notes, trips and re-issues in the last 24 hours", () => {
    store.append(record());
    store.append(record());
    store.append(patternTrip("fork bomb"));
    store.append(record({ decision: "trip-repeat" }));
    store.append(record({ decision: "reissue", affirmation: "the request says clean the build" }));
    store.append(record({ decision: "reissue-ran" }));
    store.append(record({ decision: "silent-uncertain", suppressed: "uncertain" }));

    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("notes handed to Claude: 2   suppressed: 1");
    expect(report).toContain("tripwires: 1 opened, 1 repeats, 1 re-issued (1 ran, 0 failed)");
  });

  it("counts the marker hygiene lines", () => {
    store.append(record({ decision: "marker-unmatched" }));
    store.append(record({ decision: "marker-short" }));
    store.append(record({ decision: "affirm" }));
    store.append(record({ decision: "marker-pass" }));
    store.append(record({ decision: "marker-unverified" }));
    store.append(record({ decision: "affirm-unverified" }));
    expect(statusReport(testConfig(dir), store, NOW)).toContain(
      "markers: 1 sidecar affirmations, 1 answered a trip on a verified quote, 2 refused (quote not the user's), 1 on user-owned code-rule calls, 1 too short",
    );
  });

  it("counts the last 24 hours by event and decision", () => {
    store.append(record());
    store.append(record({ decision: "allow" }));
    store.append(record({ event: "Stop", decision: "block" }));
    store.append(record({ ts: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString() }));

    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("Last 24 h (3 logged decisions of 4 total)");
    expect(report).toMatch(/PreToolUse: 2/);
    expect(report).toMatch(/Stop: 1/);
  });

  it("reports latency percentiles and an estimated cost", () => {
    for (const latency of [100, 200, 300, 400, 5000]) {
      store.append(record({ latency_ms: latency, input_tokens: 1_000_000 }));
    }
    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("p50 300 ms");
    expect(report).toContain("p95 5000 ms");
    expect(report).toContain(`$${(5 * USD_PER_MTOK).toFixed(4)}`);
  });

  it("keeps re-issue bookkeeping out of the latency figures", () => {
    // A `reissue-ran` latency is the tool's own run time, not a Jev call.
    store.append(record({ latency_ms: 400 }));
    const { model: _model, signals: _signals, policy: _policy, ...bare } = record();
    store.append({ ...bare, event: "PostToolUse", decision: "reissue-ran", latency_ms: 32_342 });
    expect(statusReport(testConfig(dir), store, NOW)).toContain("p95 400 ms (1 calls)");
  });

  it("reports the error count and the last error", () => {
    store.append(record());
    store.append(record({ decision: "error", error: "JevTimeoutError: deadline" }));
    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("errors: 1");
    expect(report).toContain("JevTimeoutError: deadline");
  });

  it("surfaces the gate_mode migration warning rather than hiding it", () => {
    const config = testConfig(dir, {
      warnings: ['gate_mode is deprecated; read as gate=advisory. Set "gate" in /plugin config.'],
    });
    const report = statusReport(config, store, NOW);
    expect(report).toContain("option warnings");
    expect(report).toContain("gate_mode is deprecated");
  });

  it("reads an empty log without complaining", () => {
    expect(statusReport(testConfig(dir), store, NOW)).toContain("0 logged decisions");
  });
});

describe("whyReport", () => {
  it("explains that nothing has happened yet", () => {
    expect(whyReport(store)).toContain("no note, trip and error records yet");
  });

  it("prints the exact text the agent was handed", () => {
    store.append(record());
    const report = whyReport(store, 1);
    expect(report).toContain("said to Claude: [jev] The Bash call above (rm -rf build) was scored destructive");
    expect(report).toContain("driven by: destructive");
  });

  it("shows a refused marker on a code-rule trip, with the marker text, in both views", () => {
    store.append(patternTrip("rm-rf-wide"));
    store.append(
      record({
        decision: "marker-refused",
        trip_id: "t-aaaaaaaa",
        source: "pattern",
        channel: "ask",
        affirmation: "the user asked for a clean home directory",
      }),
    );
    store.append(record({ decision: "affirm-refused", trip_id: "t-aaaaaaaa", source: "pattern", affirmation: "sidecar text" }));
    for (const filter of ["all", "trips"] as const) {
      const report = whyReport(store, 3, filter);
      expect(report, filter).toContain("→  marker-refused");
      expect(report, filter).toContain("marker text: the user asked for a clean home directory");
      expect(report, filter).toContain("→  affirm-refused");
    }
  });

  it("shows which user message a verified quote matched, and why a quote was refused", () => {
    store.append(
      record({
        decision: "reissue",
        trip_id: "t-aaaaaaaa",
        source: "model",
        affirmation: '"keep going with the jevwire fix" release step',
        marker_check: "verified",
        marker_match: { age: 4, message: "keep going with the jevwire fix, and its next release" },
        standing: [{ age: 4, text: "keep going with the jevwire fix, and its next release" }],
      }),
    );
    store.append(record({ decision: "marker-unverified", marker_check: "unverified", marker_refusal: "not-found", affirmation: '"ship it all" ok' }));
    store.append(
      record({
        decision: "note",
        marker_check: "verified",
        marker_used: false,
        marker_match: { age: 0, message: "ship the parser fix today" },
      }),
    );
    store.append(record({ decision: "marker-pass", marker_check: "legacy", affirmation: "the user asked for it" }));
    for (const filter of ["all", "trips"] as const) {
      const report = whyReport(store, 4, filter);
      if (filter === "all") expect(report).toContain("marker not needed: the judgment passed the call on its own");
      expect(report, filter).toContain("quote verified in the user message 4 back: keep going with the jevwire fix, and its next release");
      expect(report, filter).toContain("→  marker-unverified");
      expect(report, filter).toContain("quote refused: the quoted text is not in any of the user's messages");
      expect(report, filter).toContain("quote not verified: accepted on trust (legacy_markers)");
      expect(report, filter).toContain("standing instructions read: 4 prompts ago: keep going with the jevwire fix");
    }
  });

  it("prints the trip id and its source", () => {
    store.append(patternTrip("fork bomb"));
    const report = whyReport(store, 1);
    expect(report).toContain("tripwire: t-aaaaaaaa (pattern)");
    expect(report).toContain("prefilter: fork bomb");
  });

  it("prints the marker text and the trip it answered, for a re-issue", () => {
    store.append(
      record({
        decision: "reissue",
        trip_id: "t-aaaaaaaa",
        source: "model",
        affirmation: 'the request says "reset the dev database before seeding"',
      }),
    );
    const report = whyReport(store, 1);
    expect(report).toContain("→  reissue");
    expect(report).toContain("tripwire: t-aaaaaaaa (model)");
    expect(report).toContain("marker text: the request says");
  });

  it("names every policy option in force", () => {
    store.append(
      record({
        policy: {
          ignore_scope: false,
          uncertain: "risky-lean",
          lenient_scope: true,
          trust_requested: true,
          corroborate_uncertain: true,
        },
      }),
    );
    const report = whyReport(store, 1);
    expect(report).toContain("uncertain=risky-lean");
    expect(report).toContain("in_scope used");
    expect(report).toContain("lenient_scope=true");
    expect(report).toContain("trust_requested=true");
    expect(report).toContain("corroborate_uncertain=true");
  });

  it("omits an option that was not recorded, rather than guessing a default", () => {
    store.append(record({ policy: { ignore_scope: true, uncertain: "confirm" } }));
    const report = whyReport(store, 1);
    expect(report).toContain("in_scope ignored");
    expect(report).not.toContain("corroborate_uncertain");
  });

  it("shows the most recent records newest first and leaves silence out", () => {
    store.append(record({ subject: "subject-alpha" }));
    store.append(record({ subject: "subject-beta" }));
    store.append(record({ subject: "subject-silent", decision: "silent-uncertain", suppressed: "uncertain" }));
    const report = whyReport(store, 2);
    expect(report.indexOf("subject-beta")).toBeLessThan(report.indexOf("subject-alpha"));
    expect(report).not.toContain("subject-silent");
    expect(report).toContain("destructive=0.95");
  });

  it("honours the count", () => {
    for (const n of [1, 2, 3, 4, 5]) store.append(record({ subject: `s${n}` }));
    expect(whyReport(store, 1)).toContain("last 1 note");
  });

  describe("filters", () => {
    beforeEach(() => {
      store.append(record({ subject: "a-note" }));
      store.append(patternTrip("fork bomb", { subject: "a-trip" }));
      store.append(record({ subject: "a-reissue", decision: "reissue", trip_id: "t-aaaaaaaa" }));
      store.append(record({ subject: "an-error", decision: "error", error: "boom" }));
    });

    it("notes only", () => {
      const report = whyReport(store, 10, "notes");
      expect(report).toContain("a-note");
      expect(report).not.toContain("a-trip");
      expect(report).not.toContain("an-error");
    });

    it("trips only, including how each one ended", () => {
      const report = whyReport(store, 10, "trips");
      expect(report).toContain("a-trip");
      expect(report).toContain("a-reissue");
      expect(report).not.toContain("a-note");
    });

    it("everything the agent was told, plus errors, by default", () => {
      const report = whyReport(store, 10);
      for (const subject of ["a-note", "a-trip", "a-reissue", "an-error"]) expect(report).toContain(subject);
    });
  });
});

describe("calibrateReport", () => {
  it("says there is nothing to calibrate on an empty log", () => {
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("Nothing judged by the model yet");
  });

  it("reports what Claude was told, and what was suppressed", () => {
    store.append(prompt(120_000));
    store.append(record());
    store.append(record({ fingerprint: "2222", subject: "other" }));
    store.append(record({ decision: "silent-uncertain", suppressed: "uncertain" }));
    store.append(record({ decision: "silent-dup", suppressed: "dup" }));
    store.append(record({ decision: "allow", suppressed: "allow" }));

    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("1. What Claude was told");
    expect(report).toContain("notes emitted: 2");
    expect(report).toContain("uncertain: 1");
    expect(report).toContain("dup: 1");
    expect(report).toContain("notes by driving signal:");
    expect(report).toContain("destructive: 2");
    expect(report).toContain("notes per user prompt: mean 2.00, max 2 (cap 5, 1 prompts)");
  });

  it("says so plainly when no prompt has been recorded", () => {
    store.append(record());
    expect(calibrateReport(testConfig(dir), store)).toContain("notes per user prompt: no prompts recorded yet");
  });

  it("reports the tripwire lifecycle", () => {
    store.append(patternTrip("fork bomb"));
    store.append(record({ decision: "trip-repeat", trip_id: "t-aaaaaaaa" }));
    store.append(
      record({
        decision: "reissue",
        trip_id: "t-aaaaaaaa",
        ts: new Date(NOW - 30_000).toISOString(),
        affirmation: "the request says remove the build directory",
      }),
    );
    store.append(record({ decision: "reissue-ran", trip_id: "t-aaaaaaaa" }));
    store.append(record({ decision: "trip", source: "model", trip_id: "t-bbbbbbbb", firm: ["outward"] }));

    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("2. Tripwires");
    expect(report).toContain("opened: 2   repeats: 1   re-issued: 1   not re-issued: 1");
    expect(report).toContain("pattern: 1");
    expect(report).toContain("model: 1");
    expect(report).toContain("by code rule:");
    expect(report).toContain("by top signal (model trips):");
    expect(report).toContain("re-issues that ran: 1, that failed: 0");
    expect(report).toContain("median trip → re-issue: 30s");
  });

  it("reports a deny loop rather than capping it", () => {
    store.append(patternTrip("fork bomb"));
    store.append(record({ decision: "trip-repeat", trip_id: "t-aaaaaaaa" }));
    store.append(record({ decision: "trip-repeat", trip_id: "t-aaaaaaaa" }));
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("stuck (3+ denies of the same call): 1");
    expect(report).toContain("a cap that went silent would be a bypass");
  });

  it("reports marker hygiene as the reflex metric", () => {
    store.append(record({ decision: "marker-unmatched" }));
    store.append(record({ decision: "marker-unmatched" }));
    store.append(record({ decision: "marker-short" }));
    store.append(record({ decision: "affirm-unmatched" }));
    store.append(record({ decision: "marker-unverified" }));
    store.append(record({ decision: "marker-pass", marker_used: true }));
    store.append(record({ decision: "allow", marker_used: false }));
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("markers refused because the quote was not the user's: 1");
    expect(report).toContain("tripped judgments answered on the spot by a verified quote: 1");
    expect(report).toContain("verified markers on calls the judgment passed anyway (unused): 1");
    expect(report).toContain("markers on user-owned code-rule calls (never honoured): 2");
    expect(report).toContain("markers too short to count as a reason (legacy_markers): 1");
    expect(report).toContain("sidecar affirmations naming an unknown trip: 1");
    expect(report).toContain("the reflex metric");
  });

  it("splits the signal histograms by what the gate did", () => {
    store.append(record());
    store.append(record({ decision: "trip", source: "model" }));
    store.append(record({ decision: "allow", suppressed: "allow" }));
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("4. Signal distributions, by what the gate did");
    expect(report).toContain("note (1)");
    expect(report).toContain("trip (1)");
    expect(report).toContain("silent (1)");
    expect(report).toContain("destructive");
    expect(report).toContain("blast_radius");
  });

  it("replays notes and trips at other thresholds, exactly", () => {
    // A 0.95 destructive, in scope, local: a note at every replayed threshold
    // up to 0.95, because `lean` reads p >= auto as firm.
    store.append(
      record({
        signals: { destructive: 0.95, outward_facing: 0.01, in_scope: 0.3, credential_exposure: 0.01, blast_radius: 0.1 },
      }),
    );
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("5. Replay at other thresholds, over your own log");
    expect(report).toContain("5a gate");
    expect(report).toMatch(/auto 0\.85: 1 notes \+ 0 trips = 1/);
    expect(report).toMatch(/auto 0\.95: 1 notes \+ 0 trips = 1/);
    expect(report).toContain("the per-session duplicate check and the five-note");
  });

  /**
   * Section 5 replays four events now, not one. The point of each of the three
   * new ones is the same as the gate's: the log carries what the decision was
   * made from, so the report re-runs the pure function rather than estimating.
   */
  describe("the four replays", () => {
    it("says plainly when an event has no records to replay", () => {
      store.append(record());
      const report = calibrateReport(testConfig(dir), store);
      expect(report).toContain("5b stop (0 judged)");
      expect(report).toContain("5c screen (0 judged)");
      expect(report).toContain("5d prompt kind");
      expect(report).toContain("route_prompts is off unless you turned it on");
    });

    it("replays the stop check over the three unfinished Nouls", () => {
      store.append(stopRecord({ says_part_not_done: 0.9, asks_user: 0.02 }));
      store.append(stopRecord({ says_check_failing: 0.99, asks_user: 0.02 }));
      store.append(stopRecord({ says_part_not_done: 0.2, asks_user: 0.02 }));
      const report = calibrateReport(testConfig(dir), store);
      expect(report).toContain("5b stop (3 judged)");
      expect(report).toContain("auto 0.85: 2 blocks of 3");
      expect(report).toContain("auto 0.95: 1 blocks of 3");
      expect(report).toContain("which is session state and not in this log");
    });

    /** A record written before 0.5.0 has the compound question, and only that. */
    it("replays a legacy stop record off admits_unfinished", () => {
      store.append(stopRecord({ admits_unfinished: 0.95, asks_user: 0.02 }));
      store.append(stopRecord({ admits_unfinished: 0.95, asks_user: 0.9 }));
      const report = calibrateReport(testConfig(dir), store);
      expect(report).toContain("auto 0.85: 1 blocks of 2");
    });

    it("replays the screen in the cascade's order", () => {
      store.append(screenRecord({ injection: 0.96 }));
      store.append(screenRecord({ injection: 0.1, contradicts_premise: 0.93 }));
      store.append(screenRecord({ injection: 0.02, contradicts_premise: 0.02 }));
      const report = calibrateReport(testConfig(dir), store);
      expect(report).toContain("5c screen (3 judged)");
      expect(report).toContain("auto 0.85: 1 flagged + 1 contradictions of 3");
    });

    it("replays the prompt kind against the confidence bar, not the auto bar", () => {
      store.append(kindRecord(0.97));
      store.append(kindRecord(0.72));
      const report = calibrateReport(testConfig(dir), store);
      expect(report).toContain("5d prompt kind (currently confidence 0.85; 2 judged)");
      expect(report).toContain("confidence 0.70: 2 printed of 2");
      expect(report).toContain("confidence 0.85: 1 printed of 2");
    });

    /**
     * A record logged before 0.5.0 carries neither `blast_p_high` nor
     * `mentions_target`, and has to replay on the rules it actually decided
     * on: the expectation, and an un-vetoed out-of-scope reading.
     */
    it("replays a legacy gate record on the expectation rule", () => {
      // A wide-radius note: unrequested, nothing else firing.
      store.append(
        record({
          decision: "note",
          firm: ["wide"],
          signals: {
            destructive: 0.02,
            outward_facing: 0.02,
            in_scope: 0.3,
            credential_exposure: 0.01,
            blast_radius: 2.4,
          },
        }),
      );
      expect(calibrateReport(testConfig(dir), store)).toMatch(/auto 0\.85: 1 notes \+ 0 trips = 1/);
    });

    it("uses blast_p_high when the record has it", () => {
      store.append(
        record({
          decision: "note",
          firm: ["wide"],
          signals: {
            destructive: 0.02,
            outward_facing: 0.02,
            in_scope: 0.3,
            credential_exposure: 0.01,
            blast_radius: 2.4,
            // The same expectation, with most of its mass on the narrow
            // levels: not wide, so the note the 0.3 rule called for goes away.
            blast_p_high: 0.3,
          },
        }),
      );
      expect(calibrateReport(testConfig(dir), store)).toMatch(/auto 0\.85: 0 notes \+ 0 trips = 0/);
    });

    it("shows the 0.5.0 scope histograms only when a record carries them", () => {
      store.append(record());
      expect(calibrateReport(testConfig(dir), store)).not.toContain("scope_unrelated");

      store.append(
        record({
          fingerprint: "3333",
          signals: {
            destructive: 0.95,
            outward_facing: 0.02,
            in_scope: 0.9,
            credential_exposure: 0.01,
            blast_radius: 1.2,
            scope_unrelated: 0.1,
            scope_step: 0.8,
            scope_requested: 0.1,
            mentions_target: 0.7,
            same_task_area: 0.9,
          },
        }),
      );
      const report = calibrateReport(testConfig(dir), store);
      expect(report).toContain("scope_unrelated");
      expect(report).toContain("mentions_target");
      expect(report).toContain("same_task_area agrees with scope_step on 1/1");
    });
  });

  it("writes a zero delta as 0%, not -0%", () => {
    store.append(record());
    const report = calibrateReport(testConfig(dir), store);
    expect(report).not.toContain("-0%");
    expect(report).toContain("0% vs now");
  });

  it("prints the evidence hierarchy, and no claim to measure correctness", () => {
    store.append(record({ decision: "trip", source: "model", trip_id: "t-cccccccc" }));
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("6. How to read this");
    expect(report).toContain("A pattern trip is certain by construction");
    expect(report).toContain("was NOT re-issued (1) is the strongest");
    expect(report).toContain("A note is post-hoc by construction");
    expect(report).toContain("Nothing here measures correctness");
    // The approval correlation is gone: there are no approvals to correlate.
    expect(report).not.toContain("approved");
    expect(report).not.toContain("Approval correlation");
  });

  it("lists the newest marker texts, so a re-issue is auditable", () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      store.append(record({ decision: "reissue", trip_id: `t-${n}`, affirmation: `reason number ${n}` }));
    }
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("Newest marker texts");
    expect(report).toContain("reason number 6");
    expect(report).not.toContain("reason number 1");
  });

  it("counts code-pattern trips separately from judged decisions", () => {
    store.append(patternTrip("fork bomb"));
    // A repeat of the same pattern trip is not a second tripwire.
    store.append({ ...patternTrip("fork bomb"), decision: "trip-repeat" });
    store.append(record());
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("tripwires from a code pattern (no model): 1");
    expect(report).toContain("gate decisions judged by the model: 1");
  });

  it("prints a marker text once, not once per record that carries it", () => {
    store.append(record({ decision: "affirm", trip_id: "t-dddddddd", affirmation: "the request says do it" }));
    store.append(record({ decision: "reissue", trip_id: "t-dddddddd", affirmation: "the request says do it" }));
    const report = calibrateReport(testConfig(dir), store);
    expect(report.match(/the request says do it/g)).toHaveLength(1);
  });

  it("never prints the key", () => {
    store.append(record());
    expect(calibrateReport(testConfig(dir, { apiKey: "sk-super-secret" }), store)).not.toContain("sk-super-secret");
  });
});

/**
 * The Daemon section.
 *
 * The case that matters is the honest one: a `/jev:*` command runs through the
 * Bash tool, whose process may be sandboxed away from loopback sockets, so a
 * live daemon can be unreachable from the very shell reporting on it. Saying
 * "down" there would be a lie, and a lie that sends someone debugging.
 */
describe("the daemon section", () => {
  const view = (overrides: Partial<DaemonView> = {}): DaemonView => ({
    state: undefined,
    alive: false,
    probe: "refused",
    health: undefined,
    logPath: "/tmp/jev/daemon.log",
    ...overrides,
  });

  const state = (overrides: Partial<DaemonState> = {}): DaemonState => ({
    pid: 4242,
    port: 10522,
    version: "0.4.0",
    protocol: 1,
    bundle_path: "/plugins/jev/dist/hook.mjs",
    bundle_mtime: NOW - 86_400_000,
    data_dir: "/tmp/jev",
    started_at: NOW - 600_000,
    updated_at: NOW - 5_000,
    state: "running",
    counters: { ...emptyCounters(), hooks: { PreToolUse: 42, Stop: 3 }, jev_calls: 12, memo_hits: 7 },
    restarts: 2,
    ...overrides,
  });

  const health = (overrides: Partial<Health> = {}): Health => ({
    jev: true,
    pid: 4242,
    port: 10522,
    version: "0.4.0",
    protocol: 1,
    bundle_path: "/plugins/jev/dist/hook.mjs",
    bundle_mtime: NOW - 86_400_000,
    started_at: NOW - 600_000,
    uptime_ms: 600_000,
    sessions: 2,
    auth: "key",
    ...overrides,
  });

  it("says up, with the pid and the uptime, when the probe got through", () => {
    const lines = daemonReport(testConfig(dir), view({ state: state(), alive: true, probe: "jev", health: health() }), NOW).join("\n");
    expect(lines).toContain("status: up");
    expect(lines).toContain("pid 4242");
    expect(lines).toContain("up 10m 0s");
    expect(lines).toContain("sessions registered: 2");
    expect(lines).toContain("restarts 2");
  });

  it("says the state file vouches for it rather than `down` when the probe fails but the pid is alive", () => {
    const lines = daemonReport(testConfig(dir), view({ state: state(), alive: true, probe: "refused" }), NOW).join("\n");
    expect(lines).toContain("the state file says running and pid 4242 is alive");
    expect(lines).toContain("not reachable from this shell");
    expect(lines).toContain("sandboxed");
    expect(lines).not.toContain("status: down");
  });

  it("says down when the state file claims running and the pid is gone", () => {
    const lines = daemonReport(testConfig(dir), view({ state: state(), alive: false }), NOW).join("\n");
    expect(lines).toContain("status: down");
    expect(lines).toContain("no longer exists");
  });

  it("says down when there has never been a daemon here", () => {
    const lines = daemonReport(testConfig(dir), view(), NOW).join("\n");
    expect(lines).toContain("status: down");
    expect(lines).toContain("has never run here");
  });

  it("says down, with when, after a clean stop", () => {
    const lines = daemonReport(
      testConfig(dir),
      view({ state: state({ state: "stopped", updated_at: NOW - 90_000 }) }),
      NOW,
    ).join("\n");
    expect(lines).toContain("status: down — stopped 1m 30s ago");
  });

  it("shouts about a port conflict and says the hooks are inactive but fail open", () => {
    const lines = daemonReport(testConfig(dir), view({ state: state({ state: "port-conflict" }) }), NOW).join("\n");
    expect(lines).toContain("PORT CONFLICT");
    expect(lines).toContain("inactive");
    expect(lines).toContain("nothing is blocked");
  });

  it("flags a stale heartbeat on a daemon whose pid is alive", () => {
    const lines = daemonReport(
      testConfig(dir),
      view({ state: state({ updated_at: NOW - 120_000 }), alive: true }),
      NOW,
    ).join("\n");
    expect(lines).toContain("stale for a 15 s heartbeat");
  });

  it("reports hooks by event, memo hits and jev calls", () => {
    const lines = daemonReport(testConfig(dir), view({ state: state(), alive: true }), NOW).join("\n");
    expect(lines).toContain("hooks served: PreToolUse 42, Stop 3");
    expect(lines).toContain("jev calls: 12");
    expect(lines).toContain("memo hits: 7");
    expect(lines).toContain("counters read from the state file");
  });

  it("prefers live counters when the probe got through, and says so", () => {
    const lines = daemonReport(
      testConfig(dir),
      view({
        state: state(),
        alive: true,
        probe: "jev",
        health: health({ counters: { ...emptyCounters(), hooks: { PreToolUse: 99 } } }),
      }),
      NOW,
    ).join("\n");
    expect(lines).toContain("hooks served: PreToolUse 99");
    expect(lines).toContain("counters read live from the daemon");
  });

  it("says so plainly when there is no key and the daemon is unauthenticated", () => {
    const lines = daemonReport(
      testConfig(dir),
      view({ state: state(), alive: true, probe: "jev", health: health({ auth: "none" }) }),
      NOW,
    ).join("\n");
    expect(lines).toContain("auth: none");
    expect(lines).toContain("nothing to spend");
  });

  it("notices a daemon speaking another protocol and says it will be replaced", () => {
    const lines = daemonReport(
      testConfig(dir),
      view({ state: state(), alive: true, probe: "jev", health: health({ protocol: 99 }) }),
      NOW,
    ).join("\n");
    expect(lines).toContain("it speaks protocol 99");
    expect(lines).toContain("replaces it");
  });

  it("never prints a key", () => {
    const lines = daemonReport(
      testConfig(dir, { apiKey: "sk-super-secret" }),
      view({ state: state(), alive: true, probe: "jev", health: health() }),
      NOW,
    ).join("\n");
    expect(lines).not.toContain("sk-super-secret");
  });
});

describe("statusReport and the daemon", () => {
  it("leaves the section out entirely when the caller did not probe", () => {
    // `statusReport` is synchronous; a caller that cannot await a probe gets no
    // daemon section rather than an invented one.
    expect(statusReport(testConfig(dir), store, NOW)).not.toContain("Daemon");
  });

  it("appends the section when the caller passes a view", () => {
    const report = statusReport(testConfig(dir), store, NOW, {
      state: undefined,
      alive: false,
      probe: "refused",
      health: undefined,
      logPath: "/tmp/jev/daemon.log",
    });
    expect(report).toContain("Daemon");
    expect(report).toContain("has never run here");
  });

  it("excludes memo hits from the latency percentiles and counts them separately", () => {
    // A hit is honestly 0 ms, but a p50 over calls that never happened would
    // flatter the real latency.
    for (let i = 0; i < 4; i += 1) store.append(record({ latency_ms: 400 }));
    for (let i = 0; i < 4; i += 1) store.append(record({ latency_ms: 0, input_tokens: 0, memo: true }));
    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("(4 calls)");
    expect(report).toContain("p50 400 ms");
    expect(report).toContain("4 were answered from the daemon's memo");
  });
});
