/**
 * Store: session state, the decision log, rotation, pruning, and the two
 * scopes of `/jev:off`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  migrateLegacyDataDir,
  nextPrompts,
  requestText,
  LOG_ROTATE_BYTES,
  SESSION_TTL_MS,
  Store,
  safeSessionId,
  type DecisionRecord,
} from "../../src/hooks/store.js";
import { loadHookConfig } from "../../src/hooks/config.js";
import { sessionConfigOf } from "../../src/hooks/daemon/registry.js";
import { TRIP_TTL_MS, type Trip } from "../../src/hooks/tripwire.js";
import { cleanup, tempDir } from "./helpers.js";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = tempDir();
  store = new Store(dir);
});
afterEach(() => {
  cleanup(dir);
});

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    ts: new Date().toISOString(),
    session_id: "s1",
    event: "PreToolUse",
    decision: "ask",
    ...overrides,
  };
}

describe("safeSessionId", () => {
  it("keeps an ordinary id", () => {
    expect(safeSessionId("abc-123_DEF")).toBe("abc-123_DEF");
  });

  it("cannot be used to escape the data directory", () => {
    expect(safeSessionId("../../etc/passwd")).not.toContain("/");
    expect(safeSessionId("../../etc/passwd")).not.toContain("..");
  });

  it("never produces an empty name", () => {
    expect(safeSessionId("")).toBe("unknown");
    expect(safeSessionId("///")).not.toBe("");
  });
});

describe("session state", () => {
  it("reads an empty state for an unknown session", () => {
    expect(store.readSession("nope")).toEqual({ prompts: [], stop_blocks: 0 });
  });

  it("round-trips what it wrote", () => {
    store.writeSession("s1", { prompts: ["a"], stop_blocks: 2, disabled: true });
    const session = store.readSession("s1");
    expect(session.prompts).toEqual(["a"]);
    expect(session.stop_blocks).toBe(2);
    expect(session.disabled).toBe(true);
    expect(session.updated).toBeTypeOf("number");
  });

  it("survives a corrupt session file", () => {
    store.writeSession("s1", { prompts: ["a"], stop_blocks: 0 });
    writeFileSync(join(dir, "sessions", "s1.json"), "{not json");
    expect(store.readSession("s1")).toEqual({ prompts: [], stop_blocks: 0 });
  });

  it("ignores fields of the wrong type", () => {
    store.writeSession("s1", { prompts: [], stop_blocks: 0 });
    writeFileSync(join(dir, "sessions", "s1.json"), JSON.stringify({ prompts: "nope", stop_blocks: "nope" }));
    expect(store.readSession("s1")).toEqual({ prompts: [], stop_blocks: 0 });
  });
});

describe("disable flags", () => {
  it("disables one session without touching another", () => {
    store.setDisabled("s1", true);
    expect(store.isDisabled("s1")).toBe(true);
    expect(store.isDisabled("s2")).toBe(false);
  });

  it("re-enables a session", () => {
    store.setDisabled("s1", true);
    store.setDisabled("s1", false);
    expect(store.isDisabled("s1")).toBe(false);
  });

  it("falls back to a global flag when the session is unknown", () => {
    const result = store.setDisabled(null, true);
    expect(result.scope).toBe("global");
    expect(store.isDisabled("any-session")).toBe(true);
  });

  it("clears the global flag when a session is re-enabled", () => {
    store.setDisabled(null, true);
    store.setDisabled("s1", false);
    expect(existsSync(store.globalDisablePath)).toBe(false);
    expect(store.isDisabled("s1")).toBe(false);
  });
});

describe("pending re-issues", () => {
  it("remembers and consumes one", () => {
    store.rememberReissue("s1", { tool_use_id: "t1", ts: 1, tool_name: "Bash", trip_id: "t-aaaaaaaa" });
    expect(store.takeReissue("s1", "t1")?.trip_id).toBe("t-aaaaaaaa");
    expect(store.takeReissue("s1", "t1")).toBeUndefined();
  });

  it("leaves other entries alone", () => {
    store.rememberReissue("s1", { tool_use_id: "t1", ts: 1, tool_name: "Bash" });
    store.rememberReissue("s1", { tool_use_id: "t2", ts: 2, tool_name: "Write" });
    store.takeReissue("s1", "t1");
    expect(store.readSession("s1").pending_reissues?.map((p) => p.tool_use_id)).toEqual(["t2"]);
  });

  it("is bounded", () => {
    for (let index = 0; index < 50; index += 1) {
      store.rememberReissue("s1", { tool_use_id: `t${index}`, ts: index, tool_name: "Bash" });
    }
    expect(store.readSession("s1").pending_reissues!.length).toBeLessThanOrEqual(20);
  });
});

describe("trips", () => {
  const NOW = 1_700_000_000_000;

  function trip(overrides: Partial<Trip> = {}): Trip {
    return {
      id: "t-11111111",
      fingerprint: "1111111111111111",
      tool_name: "Bash",
      ts: NOW,
      source: "pattern",
      reason: "recursive delete of a home path",
      denies: 1,
      ...overrides,
    };
  }

  it("opens, finds by fingerprint and finds by id", () => {
    store.openTrip("s1", trip(), NOW);
    expect(store.findTripByFingerprint("s1", "1111111111111111", NOW)?.id).toBe("t-11111111");
    expect(store.findTripById("s1", "t-11111111", NOW)?.source).toBe("pattern");
    expect(store.findTripByFingerprint("s1", "nope", NOW)).toBeUndefined();
  });

  it("expires a trip after the ttl, so a marker cannot answer an old one", () => {
    store.openTrip("s1", trip(), NOW);
    expect(store.findTripById("s1", "t-11111111", NOW + TRIP_TTL_MS)).toBeDefined();
    expect(store.findTripById("s1", "t-11111111", NOW + TRIP_TTL_MS + 1)).toBeUndefined();
    expect(store.liveTrips("s1", NOW + TRIP_TTL_MS + 1)).toEqual([]);
  });

  it("counts repeats and closes on a re-issue", () => {
    store.openTrip("s1", trip(), NOW);
    expect(store.repeatTrip("s1", "t-11111111", NOW)).toBe(2);
    expect(store.repeatTrip("s1", "t-11111111", NOW)).toBe(3);
    store.closeTrip("s1", "t-11111111", NOW);
    expect(store.liveTrips("s1", NOW)).toEqual([]);
  });

  it("records a sidecar affirmation against the trip it names", () => {
    store.openTrip("s1", trip(), NOW);
    store.affirmTrip("s1", "t-11111111", "the request says reset the dev database", NOW);
    const found = store.findTripById("s1", "t-11111111", NOW);
    expect(found?.affirmation).toContain("reset the dev database");
    expect(found?.affirmed_at).toBe(NOW);
  });

  it("replaces an expired trip for the same action rather than stacking one", () => {
    store.openTrip("s1", trip(), NOW);
    store.openTrip("s1", trip({ id: "t-11111111", ts: NOW + 1000 }), NOW + 1000);
    expect(store.liveTrips("s1", NOW + 1000)).toHaveLength(1);
  });

  it("is bounded", () => {
    for (let index = 0; index < 40; index += 1) {
      store.openTrip("s1", trip({ id: `t-${index}`, fingerprint: `fp${index}` }), NOW);
    }
    expect(store.liveTrips("s1", NOW).length).toBeLessThanOrEqual(20);
  });

  /** The session file is state we wrote, but it is still a file on disk. */
  it("drops a malformed trip instead of handing its text to a deny reason", () => {
    store.writeSession("s1", { prompts: [], stop_blocks: 0 }, NOW);
    writeFileSync(
      join(dir, "sessions", "s1.json"),
      JSON.stringify({
        prompts: [],
        stop_blocks: 0,
        trips: [
          { id: "t-ok", fingerprint: "f", tool_name: "Bash", ts: NOW, source: "model", reason: "x", denies: 1 },
          { id: 42, fingerprint: "f", tool_name: "Bash", ts: NOW, source: "model" },
          { id: "t-bad", fingerprint: "f", tool_name: "Bash", ts: NOW, source: "elsewhere" },
          "not an object",
        ],
      }),
    );
    expect(store.liveTrips("s1", NOW).map((t) => t.id)).toEqual(["t-ok"]);
  });

  it("clamps a reason read back off disk", () => {
    store.writeSession("s1", { prompts: [], stop_blocks: 0 }, NOW);
    writeFileSync(
      join(dir, "sessions", "s1.json"),
      JSON.stringify({
        prompts: [],
        stop_blocks: 0,
        trips: [
          {
            id: "t-ok",
            fingerprint: "f",
            tool_name: "Bash",
            ts: NOW,
            source: "model",
            reason: "x".repeat(5000),
            affirmation: "y".repeat(5000),
            denies: 1,
          },
        ],
      }),
    );
    const found = store.liveTrips("s1", NOW)[0]!;
    expect(found.reason.length).toBeLessThanOrEqual(200);
    expect(found.affirmation!.length).toBeLessThanOrEqual(200);
  });
});

describe("the gate-error notice clock", () => {
  it("round-trips a valid epoch and drops anything else on read", () => {
    store.updateSession("s1", (s) => ({ ...s, gate_error_notice_at: 1_700_000_000_000 }));
    expect(store.readSession("s1").gate_error_notice_at).toBe(1_700_000_000_000);
    for (const bad of ["soon", -1, Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
      store.writeSession("s1", { prompts: [], stop_blocks: 0, gate_error_notice_at: bad as unknown as number });
      expect(store.readSession("s1").gate_error_notice_at, String(bad)).toBeUndefined();
    }
  });
});

describe("noted actions", () => {
  const NOW = 1_700_000_000_000;

  it("counts notes for the per-prompt cap", () => {
    store.noteEmitted("s1", "fp1", NOW);
    store.noteEmitted("s1", "fp2", NOW);
    expect(store.readSession("s1").notes_this_prompt).toBe(2);
  });

  it("remembers a fingerprint for the dedupe window and forgets it after", () => {
    store.noteEmitted("s1", "fp1", NOW);
    expect(store.wasNoted("s1", "fp1", 1000, NOW + 500)).toBe(true);
    expect(store.wasNoted("s1", "fp1", 1000, NOW + 1001)).toBe(false);
    expect(store.wasNoted("s1", "other", 1000, NOW)).toBe(false);
  });
});

describe("decision log", () => {
  it("appends one line per record and reads them back in order", () => {
    store.append(record({ decision: "a" }));
    store.append(record({ decision: "b" }));
    const lines = readFileSync(store.logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(store.readLog().map((r) => r.decision)).toEqual(["a", "b"]);
  });

  it("skips a malformed line rather than failing the read", () => {
    store.append(record({ decision: "a" }));
    writeFileSync(store.logPath, `${readFileSync(store.logPath, "utf8")}{broken\n`);
    expect(store.readLog()).toHaveLength(1);
  });

  it("rotates at the size limit and keeps one generation", () => {
    writeFileSync(store.logPath, "x".repeat(LOG_ROTATE_BYTES + 1));
    store.append(record({ decision: "after-rotation" }));
    expect(existsSync(join(dir, "decisions.1.jsonl"))).toBe(true);
    expect(statSync(store.logPath).size).toBeLessThan(LOG_ROTATE_BYTES);
    // The rotated generation is still readable, oldest first.
    expect(store.readLog().at(-1)?.decision).toBe("after-rotation");
  });

  it("reads an empty log as an empty array", () => {
    expect(store.readLog()).toEqual([]);
  });
});

describe("pruning", () => {
  it("removes session files past the ttl and keeps fresh ones", () => {
    store.writeSession("old", { prompts: [], stop_blocks: 0 });
    store.writeSession("new", { prompts: [], stop_blocks: 0 });
    const oldPath = join(dir, "sessions", "old.json");
    const stale = (Date.now() - SESSION_TTL_MS - 60_000) / 1000;
    utimesSync(oldPath, stale, stale);

    expect(store.pruneSessions(Date.now())).toBe(1);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(join(dir, "sessions", "new.json"))).toBe(true);
  });

  it("runs at most once a day", () => {
    store.pruneSessions(Date.now());
    store.writeSession("old", { prompts: [], stop_blocks: 0 });
    const oldPath = join(dir, "sessions", "old.json");
    const stale = (Date.now() - SESSION_TTL_MS - 60_000) / 1000;
    utimesSync(oldPath, stale, stale);
    expect(store.pruneSessions(Date.now())).toBe(0);
    expect(existsSync(oldPath)).toBe(true);
  });
});

describe("resilience", () => {
  it("does not throw when the data directory cannot be created", () => {
    const blocked = new Store("/dev/null/cannot-exist");
    expect(() => blocked.append(record())).not.toThrow();
    expect(() => blocked.writeSession("s1", { prompts: [], stop_blocks: 0 })).not.toThrow();
    expect(blocked.readSession("s1")).toEqual({ prompts: [], stop_blocks: 0 });
    expect(blocked.readLog()).toEqual([]);
    expect(blocked.isDisabled("s1")).toBe(false);
  });
});

describe("requestText", () => {
  it("joins everything when it fits", () => {
    expect(requestText(["first", "second"], 100)).toBe("first\n---\nsecond");
    expect(requestText([], 100)).toBe("");
  });

  it("drops the oldest prompts first, never the newest", () => {
    const old = "o".repeat(60);
    const mid = "m".repeat(60);
    const latest = "push the release";
    const text = requestText([old, mid, latest], 100);
    expect(text.endsWith(latest)).toBe(true);
    expect(text).toContain(mid);
    expect(text).not.toContain(old);
    expect(text.length).toBeLessThanOrEqual(100);
  });

  it("cuts a single oversized prompt rather than returning nothing", () => {
    expect(requestText(["x".repeat(500)], 100)).toHaveLength(100);
  });
});

describe("nextPrompts", () => {
  it("preserves chronological order across short and substantive prompts", () => {
    const a = "a".repeat(50);
    const b = "b".repeat(50);
    expect(nextPrompts([a, "go"], b)).toEqual([a, "go", b]);
  });

  it("caps short and substantive prompts independently", () => {
    const long = ["a", "b", "c", "d"].map((c) => c.repeat(50));
    let prompts: string[] = [];
    for (const p of [long[0], "one", long[1], "two", long[2], "three", long[3]] as string[]) prompts = nextPrompts(prompts, p);
    expect(prompts).toEqual([long[1], "two", long[2], "three", long[3]]);
  });
});


describe("the session config snapshot on disk", () => {
  it("survives a write and a read, so a replaced daemon can reload it", () => {
    const store = new Store(dir);
    const snapshot = sessionConfigOf(loadHookConfig({ JEV_GATE: "strict" }));
    store.updateSession("s1", (state) => ({ ...state, config: snapshot }));
    expect(store.readSession("s1").config).toEqual(snapshot);
  });

  it("drops a snapshot that is not an object, leaving validation to its consumer", () => {
    const store = new Store(dir);
    // A real write first, so the sessions directory exists to be corrupted.
    store.writeSession("s2", { prompts: [], stop_blocks: 0 });
    for (const bad of ['"off"', "42", "null", "[1,2]"]) {
      writeFileSync(join(dir, "sessions", "s2.json"), `{"prompts":[],"stop_blocks":0,"config":${bad}}`);
      expect(store.readSession("s2").config, bad).toBeUndefined();
    }
  });
});

describe("nextPrompts and a double-fired hook", () => {
  it("drops an identical consecutive prompt", () => {
    // UserPromptSubmit has both an http entry and a command fallback in 0.4.0.
    // The fallback checks the port first and normally says nothing, but a lost
    // race must be invisible rather than evict the request before it.
    expect(nextPrompts(["make it public"], "make it public")).toEqual(["make it public"]);
    expect(nextPrompts([], "first")).toEqual(["first"]);
  });

  it("still keeps a repeat that is not consecutive", () => {
    // "go" twice with something in between is a real pair of instructions, and
    // the dedupe is only about the *last* one. The short-prompt budget of two
    // then does its usual job on the oldest.
    const long = "rewrite the parser so it handles both quoting forms".padEnd(60, ".");
    expect(nextPrompts([long, "go"], "go")).toEqual([long, "go"]);
    // Three short prompts exceed the budget of two, so the oldest short goes.
    expect(nextPrompts([long, "go", "wait"], "go")).toEqual([long, "wait", "go"]);
  });

  it("does not let a duplicate evict the substantive prompt before it", () => {
    const long = "a".repeat(80);
    let prompts = nextPrompts([], long);
    for (let i = 0; i < 5; i += 1) prompts = nextPrompts(prompts, "ship it");
    expect(prompts).toEqual([long, "ship it"]);
  });
});

describe("migrateLegacyDataDir", () => {
  it("copies the old marketplace's data into the new directory exactly once, never overwriting", () => {
    const root = tempDir();
    const legacy = join(root, "jev-brainwires-jev");
    const current = join(root, "jev-brainwires-jevwire");
    mkdirSync(join(legacy, "sessions"), { recursive: true });
    writeFileSync(join(legacy, "decisions.jsonl"), '{"decision":"old"}\n');
    writeFileSync(join(legacy, "sessions", "s1.json"), "{}");

    expect(migrateLegacyDataDir(current)).toBe(true);
    expect(readFileSync(join(current, "decisions.jsonl"), "utf8")).toContain('"old"');
    expect(existsSync(join(current, "sessions", "s1.json"))).toBe(true);

    writeFileSync(join(current, "decisions.jsonl"), '{"decision":"new"}\n');
    expect(migrateLegacyDataDir(current)).toBe(false);
    expect(readFileSync(join(current, "decisions.jsonl"), "utf8")).toContain('"new"');
    cleanup(root);
  });

  it("does nothing for a directory that is not a known rename, or when there is nothing to copy", () => {
    const root = tempDir();
    expect(migrateLegacyDataDir(join(root, "jev"))).toBe(false);
    expect(migrateLegacyDataDir(join(root, "jev-brainwires-jevwire"))).toBe(false);
    expect(existsSync(join(root, "jev-brainwires-jevwire"))).toBe(false);
    cleanup(root);
  });

  it("runs from the Store constructor", () => {
    const root = tempDir();
    mkdirSync(join(root, "jev-brainwires-jev"), { recursive: true });
    writeFileSync(join(root, "jev-brainwires-jev", "decisions.jsonl"), '{"decision":"old"}\n');
    const store = new Store(join(root, "jev-brainwires-jevwire"));
    expect(store.readLog()).toHaveLength(1);
    cleanup(root);
  });
});
