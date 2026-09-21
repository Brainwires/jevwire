import { describe, expect, it } from "vitest";
import { BudgetError } from "../../src/decision/budget.js";
import type { Answer } from "../../src/decision/types.js";
import * as pickTool from "../../src/tools/pick.js";
import { choice, FakeModel, noul, testConfig } from "../helpers/fake-model.js";

function candidates(n: number, textFor: (i: number) => string = (i) => `candidate ${i}`) {
  return Array.from({ length: n }, (_v, i) => ({ id: `c${i}`, text: textFor(i) }));
}

describe("jev_pick", () => {
  it("sends texts index-keyed and never the ids", async () => {
    const model = new FakeModel((call) => {
      // The state carries only the texts, under `candidates`; no id appears.
      const state = call.state as { question: string; candidates: string[] };
      expect(state.candidates).toEqual(["alpha def", "beta def", "gamma def"]);
      expect(JSON.stringify(call.state)).not.toContain("c0");
      // Questions: one `pick` Choice keyed "0".."2" + none, plus fits_0..2.
      expect(Object.keys(call.questions).sort()).toEqual(["fits_0", "fits_1", "fits_2", "pick"]);
      const answers: Record<string, Answer> = {
        pick: choice("1", { "0": 0.1, "1": 0.85, "2": 0.03, none: 0.02 }, 0.9),
        fits_0: noul(0.2),
        fits_1: noul(0.95),
        fits_2: noul(0.1),
      };
      return answers;
    });
    const out = await pickTool.run(
      model,
      {
        question: "which is the definition?",
        candidates: [
          { id: "c0", text: "alpha def" },
          { id: "c1", text: "beta def" },
          { id: "c2", text: "gamma def" },
        ],
      },
      testConfig,
    );
    expect(out.pick).toBe("c1");
    expect(out.confidence).toBe(0.9);
    expect(out.gate).toBe("auto");
    expect(out.probabilities).toEqual({ c0: 0.1, c1: 0.85, c2: 0.03, none: 0.02 });
    expect(out.fits).toEqual({ c0: 0.2, c1: 0.95, c2: 0.1 });
  });

  it("returns pick: null when `none` wins", async () => {
    const model = new FakeModel(() => ({
      pick: choice("none", { "0": 0.2, "1": 0.2, none: 0.6 }, 0.7),
      fits_0: noul(0.1),
      fits_1: noul(0.1),
    }));
    const out = await pickTool.run(
      model,
      { question: "q", candidates: candidates(2) },
      testConfig,
    );
    expect(out.pick).toBeNull();
    expect(out.probabilities.none).toBe(0.6);
    expect(out.gate).toBe("review");
  });

  it("uses none_label as the none option's rubric", async () => {
    const model = new FakeModel((call) => {
      const q = call.questions.pick as { criteria: Record<string, string | null> };
      expect(q.criteria.none).toBe("no matching symbol");
      return { pick: choice("0", { "0": 0.9, "1": 0.05, none: 0.05 }, 0.9), fits_0: noul(0.9), fits_1: noul(0.1) };
    });
    await pickTool.run(
      model,
      { question: "q", candidates: candidates(2), none_label: "no matching symbol" },
      testConfig,
    );
  });

  it("rejects duplicate ids before any call", async () => {
    const model = new FakeModel(() => ({}));
    await expect(
      pickTool.run(
        model,
        { question: "q", candidates: [{ id: "x", text: "a" }, { id: "x", text: "b" }] },
        testConfig,
      ),
    ).rejects.toThrow(pickTool.PickInputError);
    expect(model.calls).toHaveLength(0);
  });

  it("rejects a candidate id equal to `none`", async () => {
    const model = new FakeModel(() => ({}));
    await expect(
      pickTool.run(
        model,
        { question: "q", candidates: [{ id: "none", text: "a" }, { id: "y", text: "b" }] },
        testConfig,
      ),
    ).rejects.toThrow(/reserved no-match/);
    expect(model.calls).toHaveLength(0);
  });

  it("throws BudgetError with no call when the candidates overflow the budget", async () => {
    const model = new FakeModel(() => ({}));
    const big = "x".repeat(60_000);
    await expect(
      pickTool.run(
        model,
        { question: "q", candidates: [{ id: "a", text: big }, { id: "b", text: big }, { id: "c", text: big }] },
        testConfig,
      ),
    ).rejects.toThrow(BudgetError);
    expect(model.calls).toHaveLength(0);
  });

  it("reads an absent or malformed pick as no match", async () => {
    const model = new FakeModel(() => ({
      // A `choice` naming an index out of range reads as no pick, not a crash.
      pick: choice("9", { "9": 1 }, 0.9),
      fits_0: noul(0.1),
      fits_1: noul(0.1),
    }));
    const out = await pickTool.run(model, { question: "q", candidates: candidates(2) }, testConfig);
    expect(out.pick).toBeNull();
  });
});
