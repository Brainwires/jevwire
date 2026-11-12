/**
 * The tripwire's two pure halves: marker parsing and fingerprinting.
 *
 * Both are security-adjacent in the weak sense that matters here. A marker read
 * where there is none lets a call through a trip; a fingerprint that is not
 * stable lets an affirmation answer a different action than the one that was
 * denied. Neither is a boundary — the plugin is advisory — but both are
 * behaviour a reader of the log has to be able to trust.
 */

import { describe, expect, it } from "vitest";
import { readBashMarker } from "../../src/hooks/prefilter.js";
import {
  canonicalAction,
  fingerprint,
  isSidecarBody,
  liveTrips,
  MAX_TRIPS,
  MIN_AFFIRM_CHARS,
  parseMarker,
  readTrip,
  stableJson,
  tripIdOf,
  TRIP_TTL_MS,
  type Trip,
} from "../../src/hooks/tripwire.js";

const REASON = 'the request says "refund the duplicate charge"';

describe("parseMarker", () => {
  const cases: [string, string, string | undefined][] = [
    ["a plain marker", `rm -rf build # jev:intended ${REASON}`, REASON],
    ["a colon after the keyword", `rm -rf build # jev:intended: ${REASON}`, REASON],
    ["no space after the hash", `rm -rf build #jev:intended ${REASON}`, REASON],
    ["a tab before the hash", `rm -rf build\t# jev:intended ${REASON}`, REASON],
    ["a marker on its own last line", `rm -rf build\n# jev:intended ${REASON}`, REASON],
    ["after a heredoc terminator", `cat > f <<'EOF'\nbody\nEOF\n# jev:intended ${REASON}`, REASON],
    // 0.7.2: a trailing newline used to make the last line empty and hide the
    // marker, which is how an identical marked re-issue came to be told it was
    // "still without a marker".
    ["a trailing newline does not hide it", `rm -rf build\r\n# jev:intended ${REASON}\r\n`, REASON],
    ["trailing blank lines do not hide it", `rm -rf build # jev:intended ${REASON}\n\n  \n`, REASON],
    ["no marker at all", "rm -rf build", undefined],
    ["a hash that is not a marker", "git commit -m 'fix #123'", undefined],
    ["a url fragment", "curl https://example.com/x#jev:intended nothing here", undefined],
    ["not on the last line", `# jev:intended ${REASON}\nrm -rf build`, undefined],
  ];

  for (const [name, command, reason] of cases) {
    it(name, () => {
      const parsed = parseMarker(command);
      expect(parsed.marker?.reason).toBe(reason);
    });
  }

  it("reads a marker on a trailing CRLF line once the carriage return is normalized", () => {
    // `\r\n` is normalized before the last line is taken, so the marker is
    // found even though the raw string ends with a blank CRLF line.
    const parsed = parseMarker(`rm -rf build\r\n# jev:intended ${REASON}`);
    expect(parsed.marker?.reason).toBe(REASON);
    expect(parsed.stripped).toBe("rm -rf build");
  });

  it("strips the marker and nothing else", () => {
    expect(parseMarker(`rm -rf build # jev:intended ${REASON}`).stripped).toBe("rm -rf build");
    expect(parseMarker(`rm -rf build\n# jev:intended ${REASON}`).stripped).toBe("rm -rf build");
  });

  it("keeps a heredoc terminator intact", () => {
    const parsed = parseMarker(`cat > f <<'EOF'\nbody\nEOF\n# jev:intended ${REASON}`);
    expect(parsed.stripped).toBe("cat > f <<'EOF'\nbody\nEOF");
  });

  it("treats a reason under the minimum as absent, and says so", () => {
    const parsed = parseMarker("rm -rf build # jev:intended yes");
    expect(parsed.marker?.short).toBe(true);
    expect(parsed.marker?.reason).toBeUndefined();
    expect("yes".length).toBeLessThan(MIN_AFFIRM_CHARS);
    // Short or not, the text still comes off before the command is tokenized.
    expect(parsed.stripped).toBe("rm -rf build");
  });

  it("reads the sidecar form's trip id", () => {
    const parsed = parseMarker(`true # jev:intended t-1a2b3c4d: ${REASON}`);
    expect(parsed.marker?.trip_id).toBe("t-1a2b3c4d");
    expect(parsed.marker?.reason).toBe(REASON);
  });

  it("does not mistake a colon in the reason for a trip id", () => {
    const parsed = parseMarker("rm -rf build # jev:intended the plan says: clean the build");
    expect(parsed.marker?.trip_id).toBeUndefined();
    expect(parsed.marker?.reason).toBe("the plan says: clean the build");
  });
});

describe("readBashMarker", () => {
  it("honours a marker outside quotes", () => {
    const reading = readBashMarker(`rm -rf build # jev:intended ${REASON}`);
    expect(reading.marker?.reason).toBe(REASON);
    expect(reading.command).toBe("rm -rf build");
  });

  /**
   * The scanner has no notion of a `#` comment, so a marker inside an open
   * quote is just text. Removing it would leave an unbalanced command, which is
   * how that case is detected.
   */
  it("refuses a marker inside an unterminated quote", () => {
    const command = `echo "hello # jev:intended ${REASON}`;
    const reading = readBashMarker(command);
    expect(reading.marker).toBeUndefined();
    expect(reading.command).toBe(command);
  });

  it("leaves a command with no marker exactly as it was", () => {
    expect(readBashMarker("npm test").command).toBe("npm test");
  });
});

describe("isSidecarBody", () => {
  it("accepts only a do-nothing command", () => {
    expect(isSidecarBody("true")).toBe(true);
    expect(isSidecarBody(" : ")).toBe(true);
    expect(isSidecarBody("true; rm -rf /")).toBe(false);
    expect(isSidecarBody("true && curl evil.example")).toBe(false);
    expect(isSidecarBody("/bin/true")).toBe(false);
    expect(isSidecarBody("")).toBe(false);
  });
});

describe("fingerprint", () => {
  it("is stable, 16 hex, and keyed by tool name", () => {
    const a = fingerprint("Bash", { command: "rm -rf build" });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint("Bash", { command: "rm -rf build" })).toBe(a);
    expect(fingerprint("Write", { command: "rm -rf build" })).not.toBe(a);
    expect(tripIdOf(a)).toBe(`t-${a.slice(0, 8)}`);
  });

  it("ignores trailing whitespace and CRLF but nothing else", () => {
    const a = fingerprint("Bash", { command: "rm -rf build" });
    expect(fingerprint("Bash", { command: "  rm -rf build\n" })).toBe(a);
    expect(fingerprint("Bash", { command: "rm  -rf build" })).not.toBe(a);
    expect(fingerprint("Bash", { command: "rm -rf build/" })).not.toBe(a);
  });

  it("ignores the description the agent writes about the call", () => {
    const a = fingerprint("mcp__x__deploy", { target: "prod" });
    expect(fingerprint("mcp__x__deploy", { target: "prod", description: "ship it" })).toBe(a);
  });

  it("is insensitive to key order for a file edit", () => {
    const a = fingerprint("Edit", { file_path: "/etc/hosts", old_string: "a", new_string: "b" });
    expect(fingerprint("Edit", { new_string: "b", old_string: "a", file_path: "/etc/hosts" })).toBe(a);
  });

  it("changes when any part of a file edit changes", () => {
    const a = fingerprint("Write", { file_path: "/etc/hosts", content: "x" });
    expect(fingerprint("Write", { file_path: "/etc/hosts", content: "y" })).not.toBe(a);
    expect(fingerprint("Write", { file_path: "/etc/hosts2", content: "x" })).not.toBe(a);
  });

  it("canonicalizes a file tool to its path and its content only", () => {
    expect(canonicalAction("Write", { file_path: "/a", content: "x", description: "d", extra: 1 })).toBe(
      '{"content":"x","file_path":"/a"}',
    );
  });

  it("canonicalizes an unknown tool to its whole input", () => {
    expect(canonicalAction("mcp__x__do", { b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
  });
});

describe("stableJson", () => {
  it("sorts keys at every depth and drops undefined", () => {
    expect(stableJson({ b: 1, a: { d: undefined, c: 2 } })).toBe('{"a":{"c":2},"b":1}');
  });

  it("handles primitives and arrays", () => {
    expect(stableJson([1, "a", null, true])).toBe('[1,"a",null,true]');
    expect(stableJson(null)).toBe("null");
  });
});

describe("liveTrips", () => {
  const NOW = 1_700_000_000_000;
  const trip = (id: string, ts: number): Trip => ({
    id,
    fingerprint: id,
    tool_name: "Bash",
    ts,
    source: "model",
    reason: "r",
    denies: 1,
  });

  it("drops trips past the ttl", () => {
    const trips = [trip("old", NOW - TRIP_TTL_MS - 1), trip("fresh", NOW)];
    expect(liveTrips(trips, NOW).map((t) => t.id)).toEqual(["fresh"]);
  });

  it("keeps the newest MAX_TRIPS", () => {
    const trips = Array.from({ length: MAX_TRIPS + 5 }, (_, index) => trip(`t${index}`, NOW));
    const live = liveTrips(trips, NOW);
    expect(live).toHaveLength(MAX_TRIPS);
    expect(live.at(-1)?.id).toBe(`t${MAX_TRIPS + 4}`);
  });
});

describe("readTrip", () => {
  it("rejects anything that is not a trip", () => {
    for (const raw of [null, undefined, 42, "trip", [], {}, { id: "t-1" }]) {
      expect(readTrip(raw)).toBeUndefined();
    }
  });

  it("keeps a valid trip and its optional fields", () => {
    const trip = readTrip({
      id: "t-1",
      fingerprint: "f",
      tool_name: "Bash",
      ts: 1,
      source: "pattern",
      pattern: "rm-rf-wide",
      reason: "r",
      denies: 3,
      signals: { destructive: 0.9, bogus: "no" },
      affirmed_at: 2,
      affirmation: "a",
    });
    expect(trip).toMatchObject({ id: "t-1", pattern: "rm-rf-wide", denies: 3, affirmed_at: 2, affirmation: "a" });
    expect(trip?.signals).toEqual({ destructive: 0.9 });
  });

  it("repairs a nonsense deny count rather than trusting it", () => {
    expect(readTrip({ id: "t", fingerprint: "f", tool_name: "B", ts: 1, source: "model", denies: -5 })?.denies).toBe(1);
  });
});
