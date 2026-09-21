import { describe, expect, it } from "vitest";
import { lintOutcome, lintQuestions, lintState, type LintOutcomeInput } from "../../src/hooks/lint-core.js";

const T = { auto: 0.85, review: 0.6 };

function outcome(signals: Record<string, number>, over: Partial<LintOutcomeInput> = {}) {
  return lintOutcome({
    signals,
    conventions: over.conventions ?? [],
    thresholds: T,
    duplicate: over.duplicate ?? false,
    notesThisPrompt: over.notesThisPrompt ?? 0,
    cap: over.cap ?? 5,
    level: over.level ?? "advisory",
  });
}

describe("lintOutcome", () => {
  it("trips on a firm hardcoded secret", () => {
    const r = outcome({ hardcodes_secret: 0.95 });
    expect(r.outcome).toBe("trip");
    expect(r.trip).toBe("hardcodes_secret");
  });

  it("trips on a removed test the user did not ask to remove", () => {
    const r = outcome({ removes_test: 0.92, requested_removal: 0.05 });
    expect(r.outcome).toBe("trip");
    expect(r.trip).toBe("removes_test");
  });

  it("notes, not trips, a removed test the user asked for", () => {
    const r = outcome({ removes_test: 0.92, requested_removal: 0.95 });
    expect(r.outcome).toBe("note");
  });

  it("notes any other firm finding at advisory level", () => {
    const r = outcome({ swallows_exception: 0.9 });
    expect(r.outcome).toBe("note");
    expect(r.findings.map((f) => f.id)).toContain("swallows_exception");
  });

  it("is silent on a firm non-block finding at tripwire level", () => {
    const r = outcome({ swallows_exception: 0.9 }, { level: "tripwire" });
    expect(r.outcome).toBe("silent");
    expect(r.suppressed).toBe("level");
    // A secret still trips at tripwire level.
    expect(outcome({ hardcodes_secret: 0.95 }, { level: "tripwire" }).outcome).toBe("trip");
  });

  it("is silent when nothing is firm", () => {
    const r = outcome({ swallows_exception: 0.4, leaves_placeholder: 0.5 });
    expect(r.outcome).toBe("silent");
    expect(r.suppressed).toBe("uncertain");
  });

  it("suppresses a duplicate note and honours the per-prompt cap", () => {
    expect(outcome({ swallows_exception: 0.9 }, { duplicate: true }).suppressed).toBe("dup");
    expect(outcome({ swallows_exception: 0.9 }, { notesThisPrompt: 5, cap: 5 }).suppressed).toBe("cap");
  });

  it("is silent entirely when the level is off", () => {
    expect(outcome({ hardcodes_secret: 0.99 }, { level: "off" }).outcome).toBe("silent");
  });

  it("reports a firm convention finding", () => {
    const r = outcome({ conv_0: 0.9 }, { conventions: ["always use bun test"] });
    expect(r.outcome).toBe("note");
    expect(r.findings[0]!.convention).toBe("always use bun test");
  });
});

describe("lintQuestions and lintState", () => {
  it("asks requested_removal only with removes_test and a request", () => {
    expect("requested_removal" in lintQuestions(["removes_test"], [], true)).toBe(true);
    expect("requested_removal" in lintQuestions(["removes_test"], [], false)).toBe(false);
    expect("requested_removal" in lintQuestions(["swallows_exception"], [], true)).toBe(false);
  });

  it("adds one conv_i per convention", () => {
    const q = lintQuestions(["swallows_exception"], ["a", "b"], false);
    expect("conv_0" in q).toBe(true);
    expect("conv_1" in q).toBe(true);
  });

  it("builds state with clipped change text and the diff lines", () => {
    const state = lintState({
      file_path: "src/x.ts",
      language: "typescript",
      change: { kind: "edit", old_string: "a", new_string: "b" },
      removed_lines: ["a"],
      added_lines: ["b"],
      conventions: [],
    });
    expect(state.file_path).toBe("src/x.ts");
    expect((state.change as Record<string, unknown>).kind).toBe("edit");
    expect(state.user_request).toBeUndefined();
  });
});
