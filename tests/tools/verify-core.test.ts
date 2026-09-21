import { describe, expect, it } from "vitest";
import type { Answer } from "../../src/decision/types.js";
import { runVerifyCore } from "../../src/tools/verify-core.js";
import { choice, FakeModel } from "../helpers/fake-model.js";

const T = { auto: 0.85, review: 0.6 };

/** Answer each `claim_N` with a fixed verdict. */
function verdictModel(verdict: "supported" | "contradicted" | "not_addressed", p: number): FakeModel {
  return new FakeModel((call) => {
    const answers: Record<string, Answer> = {};
    for (const id of Object.keys(call.questions)) {
      const probs = { supported: 0.05, contradicted: 0.05, not_addressed: 0.05 } as Record<string, number>;
      probs[verdict] = p;
      answers[id] = choice(verdict, probs, p);
    }
    return answers;
  });
}

describe("runVerifyCore", () => {
  it("verifies claims against a block of evidence", async () => {
    const model = verdictModel("supported", 0.95);
    const result = await runVerifyCore(
      model,
      { claims: ["the retry loop backs off", "tokens expire"], evidence: "the code backs off on 429", thresholds: T },
      { maxConcurrency: 4 },
    );
    expect(result.claims).toHaveLength(2);
    expect(result.claims[0]!.verdict).toBe("supported");
    expect(result.claims[0]!.gate).toBe("auto");
    expect(result.pieces).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("caps the evidence at maxPieces and flags truncation", async () => {
    const model = verdictModel("not_addressed", 0.9);
    // Evidence long enough to split into several pieces against the claim.
    const evidence = Array.from({ length: 4000 }, (_v, i) => `line ${i} of evidence text here`).join("\n");
    const result = await runVerifyCore(
      model,
      { claims: ["x"], evidence, thresholds: T, maxPieces: 1 },
      { maxConcurrency: 2 },
    );
    expect(result.pieces).toBe(1);
    expect(result.truncated).toBe(true);
    expect(model.calls).toHaveLength(1);
  });

  it("reports a contradiction firmly", async () => {
    const model = verdictModel("contradicted", 0.93);
    const result = await runVerifyCore(
      model,
      { claims: ["the project is in Rust"], evidence: "the project is written in TypeScript", thresholds: T },
      { maxConcurrency: 1 },
    );
    expect(result.claims[0]!.verdict).toBe("contradicted");
    expect(result.claims[0]!.probabilities.contradicted).toBe(0.93);
  });
});
