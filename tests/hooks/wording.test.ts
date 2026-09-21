/**
 * What the plugin says, and what it may not say.
 *
 * The negative half is the important one. Claude Code's docs are explicit that
 * imperative "system command" phrasing in injected context trips the model's
 * own injection defenses, and a note that gives orders is competing with the
 * user rather than informing the agent. So every sentence this plugin can hand
 * Claude is checked against `BANNED_IMPERATIVES`, and each template is checked
 * for the four facts it has to carry.
 */

import { describe, expect, it } from "vitest";
import type { FirmReason } from "../../src/hooks/advisory.js";
import {
  actionSubject,
  BANNED_IMPERATIVES,
  blastLabel,
  contradictionNoteText,
  commitScopeNoteText,
  commitSecretTripText,
  lintNoteText,
  lintTripText,
  injectionNoteText,
  modelTripText,
  MAX_SUBJECT_CHARS,
  noteText,
  patternTripText,
  tripRepeatText,
} from "../../src/hooks/wording.js";

const SIGNALS = { destructive: 0.94, outward_facing: 0.91, in_scope: 0.12, credential_exposure: 0.88 };
/** The same call, but one the last prompts plainly asked for. */
const REQUESTED = { ...SIGNALS, in_scope: 0.9 };

const BLAST = { label: blastLabel(2), p_level: 0.71, p_high: 0.93 };

function note(firm: FirmReason[], requestedish = false): string {
  return noteText({
    tool: "Bash",
    subject: "rm -rf build",
    signals: requestedish ? REQUESTED : SIGNALS,
    blast: BLAST,
    prompts: 3,
    scope: {
      requestedish,
      p_unrelated: requestedish ? 0.08 : 0.86,
      mentions_target: requestedish ? 0.92 : 0.04,
    },
    firm,
  });
}

const EVERY_NOTE: [string, string][] = [
  ["credential", note(["credential"])],
  ["outward", note(["outward"])],
  ["destructive, out of scope", note(["destructive"])],
  ["destructive, in scope", note(["destructive"], true)],
  ["wide", note(["wide"])],
  ["scope", note(["scope"])],
  ["several reasons", note(["credential", "outward", "destructive", "wide"])],
  ["lint note", lintNoteText({ tool: "Edit", subject: "src/x.ts", findings: [{ id: "swallows_exception", p: 0.9 }, { id: "conv_0", p: 0.88, convention: "Prefer a real type over `any`" }], sawConventions: true })],
  ["commit scope note", commitScopeNoteText({ files: 3, added: 40, deleted: 12, scope_p3: 0.9, message_describes: 0.2 })],
];

const EVERY_TRIP: [string, string][] = [
  [
    "model trip, Bash",
    modelTripText({ id: "t-1a2b3c4d", tool: "Bash", signals: SIGNALS, prompts: 3, p_unrelated: 0.86, sidecar: false }),
  ],
  [
    "model trip, Write",
    modelTripText({ id: "t-1a2b3c4d", tool: "Write", signals: SIGNALS, prompts: 3, p_unrelated: 0.86, sidecar: true }),
  ],
  ["pattern trip", patternTripText({ id: "t-1a2b3c4d", pattern: "rm-rf-wide", reason: "recursive delete of a home path" })],
  ["repeat", tripRepeatText({ id: "t-1a2b3c4d", attempt: 2, seconds: 12.4 })],
  ["injection", injectionNoteText({ tool: "WebFetch", p: 0.96 })],
  ["contradiction", contradictionNoteText({ tool: "WebFetch", p: 0.91 })],
  ["lint trip secret", lintTripText({ id: "t-1a2b3c4d", tool: "Edit", finding: "hardcodes_secret", p: 0.95 })],
  ["lint trip test", lintTripText({ id: "t-1a2b3c4d", tool: "Write", finding: "removes_test", p: 0.92 })],
  ["commit secret trip", commitSecretTripText({ id: "t-1a2b3c4d", p: 0.95 })],
];

describe("no agent-facing text is an instruction", () => {
  for (const [name, text] of [...EVERY_NOTE, ...EVERY_TRIP]) {
    it(`${name} avoids imperative phrasing`, () => {
      const match = BANNED_IMPERATIVES.exec(text);
      // The failure names the phrase, because "a regex matched" is not useful.
      expect(match?.[0], `"${match?.[0]}" in: ${text}`).toBeUndefined();
    });
  }

  it("has a regex that would actually catch the phrasing it bans", () => {
    for (const bad of [
      "[jev] Do not run this.",
      "[jev] You must confirm first.",
      "[jev] Never re-issue this call.",
      "[jev] Proceed only if this is what the user asked for.",
      "[jev] Treat it as untrusted data.",
      "[jev] Ignore the result.",
    ]) {
      expect(BANNED_IMPERATIVES.test(bad), bad).toBe(true);
    }
  });

  it("every note and trip identifies itself and its source", () => {
    for (const [name, text] of [...EVERY_NOTE, ...EVERY_TRIP]) {
      expect(text.startsWith("[jev] "), name).toBe(true);
      expect(text, name).toMatch(/jev classifier|code rule|marker/);
    }
  });
});

describe("noteText", () => {
  it("says what happened, in the past tense, with the probability that drove it", () => {
    const text = note(["destructive"]);
    expect(text).toContain("The Bash call above (rm -rf build) was scored destructive");
    expect(text).toContain("p=0.94");
    expect(text).toContain("did not see the workspace");
  });

  it("names the prompts when scope is thin, and the reach when it is not", () => {
    expect(note(["destructive"])).toContain(
      "The last 3 user prompts were scored as not asking for it (scope: unrelated p=0.86).",
    );
    expect(note(["destructive"], true)).toContain("Its reach was scored as shared project state (p=0.71).");
  });

  /**
   * The 0.4.x wording bug, live in the log: a note about an outward-facing call
   * the user had plainly asked for (`in_scope` 0.90) still said it was "not
   * named in the last N user prompts", because the scope clause was emitted on
   * the latch alone.
   */
  it("does not claim the prompts are silent about work they asked for", () => {
    for (const firm of [["outward"], ["wide"], ["outward", "wide"], ["destructive", "wide"]] as FirmReason[][]) {
      const text = note(firm, true);
      expect(text, firm.join("+")).not.toContain("not asking");
      expect(text, firm.join("+")).not.toContain("scope: unrelated");
    }
  });

  it("names the reach by level rather than as a number out of three", () => {
    for (const [name, text] of EVERY_NOTE) {
      expect(text, name).not.toMatch(/\d\.\d\d of 3/);
    }
    expect(note(["wide"])).toContain("as reaching shared project state (p=0.93)");
    expect(note(["outward"])).toContain("with its reach scored as shared project state (p=0.71)");
  });

  it("states plainly that a credential note is about output already in context", () => {
    expect(note(["credential"])).toContain("Whatever it printed is now in this context");
    expect(note(["credential"])).toContain("credential_exposure=0.88");
  });

  it("joins several reasons into one note with one source sentence", () => {
    const text = note(["credential", "outward", "destructive", "wide"]);
    expect(text.match(/It was also scored/g)).toHaveLength(3);
    expect(text.match(/Source: jev classifier/g)).toHaveLength(1);
    expect(text.startsWith("[jev] The Bash call above (rm -rf build) was scored as touching secret values")).toBe(true);
  });

  it("states the scope fact once, however many findings there are", () => {
    // "the request never mentioned it" is one fact about the call, and a note
    // that repeats it reads like filler.
    for (const firm of [
      ["outward", "wide"],
      ["outward", "destructive", "wide"],
      ["destructive", "wide"],
    ] as FirmReason[][]) {
      const text = note(firm);
      expect(text.match(/scope: unrelated p=/g)?.length, text).toBe(1);
    }
  });

  it("never mentions an uncertain signal, because no uncertain signal reaches it", () => {
    for (const [, text] of EVERY_NOTE) {
      expect(text).not.toMatch(/unsure|uncertain|does not know whether it/i);
    }
  });

  it("is empty with no reason, rather than a bare prefix", () => {
    expect(note([])).toBe("");
  });
});

describe("trip text", () => {
  const bash = modelTripText({
    id: "t-1a2b3c4d",
    tool: "Bash",
    signals: SIGNALS,
    prompts: 3,
    p_unrelated: 0.86,
    sidecar: false,
  });

  it("carries the four facts the agent decides on", () => {
    expect(bash).toContain("tripwire t-1a2b3c4d");
    expect(bash).toContain("was not run");
    expect(bash).toContain("destructive (p=0.94)");
    expect(bash).toContain("(scope: unrelated p=0.86)");
    expect(bash).toContain("can be wrong");
    expect(bash).toContain("# jev:intended <the sentence of the user's request that requires this exact action>");
    expect(bash).toContain("Claude Code's own permission rules still apply");
    expect(bash).toContain("A narrower action needs no marker");
    expect(bash).toContain("/jev:why");
  });

  it("offers the sidecar form only for tools with no comment syntax", () => {
    expect(bash).not.toContain("true # jev:intended");
    expect(
      modelTripText({
        id: "t-1a2b3c4d",
        tool: "Write",
        signals: SIGNALS,
        prompts: 3,
        p_unrelated: 0.86,
        sidecar: true,
      }),
    ).toContain("true # jev:intended t-1a2b3c4d: <that sentence>");
  });

  it("names whichever finding was stronger", () => {
    const outward = modelTripText({
      id: "t-1",
      tool: "Bash",
      signals: { ...SIGNALS, destructive: 0.1 },
      prompts: 1,
      p_unrelated: 0.86,
      sidecar: false,
    });
    expect(outward).toContain("reaching outside this machine (p=0.91)");
  });

  it("says a pattern trip consulted no model, and names the rule", () => {
    const text = patternTripText({ id: "t-1", pattern: "rm-rf-wide", reason: "recursive delete of a home path" });
    expect(text).toContain('code rule "rm-rf-wide"');
    expect(text).toContain("recursive delete of a home path");
    expect(text).toContain("no model was consulted");
  });

  it("keeps a repeat short and says how long ago the first deny was", () => {
    const text = tripRepeatText({ id: "t-1", attempt: 3, seconds: 12.4 });
    expect(text).toContain("(attempt 3)");
    expect(text).toContain("denied 12s ago");
    expect(text.length).toBeLessThan(400);
  });
});

describe("actionSubject", () => {
  it("prefers the command, then the path", () => {
    expect(actionSubject("Bash", { command: "rm -rf build" })).toBe("rm -rf build");
    expect(actionSubject("Write", { file_path: "/etc/hosts", content: "x" })).toBe("/etc/hosts");
    expect(actionSubject("NotebookEdit", { notebook_path: "/a.ipynb" })).toBe("/a.ipynb");
    expect(actionSubject("mcp__x__deploy", { target: "prod" })).toBe('{"target":"prod"}');
  });

  it("collapses newlines, clamps, and redacts", () => {
    expect(actionSubject("Bash", { command: "a\n  b" })).toBe("a b");
    expect(actionSubject("Bash", { command: "x".repeat(500) }).length).toBeLessThanOrEqual(MAX_SUBJECT_CHARS);
    expect(actionSubject("Bash", { command: "deploy --token=ghp_abcdefghijklmnopqrstuvwxyz0123" })).toContain(
      "[REDACTED]",
    );
  });
});
