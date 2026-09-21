import { describe, expect, it } from "vitest";
import { BudgetError } from "../../src/decision/budget.js";
import type { Answer, Question } from "../../src/decision/types.js";
import * as rankTool from "../../src/tools/rank.js";
import { choice, FakeModel, noul, testConfig } from "../helpers/fake-model.js";

/**
 * Answer each `cand_N` from the text it points at, plus the `which` Choice
 * (all mass on the highest-scoring candidate in the batch, so the order the
 * tool derives from the Choice matches the relevance order) and `any_relevant`
 * when the request asks it (the single or final deciding request).
 */
function relevanceResponder(scoreFor: (text: string) => number) {
  return (call: { state: unknown; questions: Record<string, Question> }): Record<string, Answer> => {
    const state = call.state as { query: string; candidates: string[] };
    const answers: Record<string, Answer> = {};
    let best = 0;
    let bestIndex = 0;
    for (const id of Object.keys(call.questions)) {
      if (!id.startsWith("cand_")) continue;
      const index = Number(id.slice("cand_".length));
      const value = scoreFor(state.candidates[index] as string);
      answers[id] = noul(value);
      if (value > best) {
        best = value;
        bestIndex = index;
      }
    }
    if (call.questions.which !== undefined) {
      answers.which = choice(String(bestIndex), { [String(bestIndex)]: 1 }, 1);
    }
    if (call.questions.any_relevant !== undefined) answers.any_relevant = noul(best);
    return answers;
  };
}

describe("jev_rank", () => {
  it("ranks candidates, maps indices back to ids, and hides the text", async () => {
    const model = new FakeModel(
      relevanceResponder((text) => (text.includes("retry") ? 0.95 : text.includes("token") ? 0.6 : 0.05)),
    );

    const result = await rankTool.run(
      model,
      {
        query: "How do I handle rate limits?",
        candidates: [
          { id: "doc:a", text: "unrelated prose about cheese" },
          { id: "doc:b", text: "retry with exponential backoff on 429" },
          { id: "doc:c", text: "token budget notes" },
        ],
      },
      testConfig,
    );

    expect(result.chunks).toBe(1);
    expect(result.total_candidates).toBe(3);
    expect(result.ranked).toEqual([
      { id: "doc:b", relevance: 0.95, rank: 1, choice: 1 },
      { id: "doc:c", relevance: 0.6, rank: 2, choice: 0 },
      { id: "doc:a", relevance: 0.05, rank: 3, choice: 0 },
    ]);
    expect(result.any_relevant).toBe(0.95);
    expect(result.choice_margin).toBe(1);
    expect(JSON.stringify(result)).not.toContain("cheese");
  });

  it("never puts caller ids in the state or in question keys", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.5));

    await rankTool.run(
      model,
      {
        query: "q",
        candidates: [
          { id: "candidates", text: "first" },
          { id: "__proto__", text: "second" },
        ],
      },
      testConfig,
    );

    const call = model.calls[0]!;
    expect(call.state).toEqual({ query: "q", candidates: ["first", "second"] });
    expect(Object.keys(call.questions).sort()).toEqual(["any_relevant", "cand_0", "cand_1", "which"]);
    expect(JSON.stringify(call)).not.toContain("__proto__");
  });

  it("breaks ties by input order", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.7));

    const result = await rankTool.run(
      model,
      {
        query: "q",
        candidates: [
          { id: "z", text: "a" },
          { id: "y", text: "b" },
          { id: "x", text: "c" },
        ],
      },
      testConfig,
    );

    expect(result.ranked.map((r) => r.id)).toEqual(["z", "y", "x"]);
    expect(result.ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("applies top_k after sorting and min_relevance before it", async () => {
    const values = [0.9, 0.2, 0.8, 0.05];
    const model = new FakeModel(relevanceResponder((text) => values[Number(text)] as number));
    const candidates = values.map((_value, index) => ({ id: `c${index}`, text: String(index) }));

    const topTwo = await rankTool.run(model, { query: "q", candidates, top_k: 2 }, testConfig);
    expect(topTwo.ranked.map((r) => r.id)).toEqual(["c0", "c2"]);

    const filtered = await rankTool.run(model, { query: "q", candidates, min_relevance: 0.5 }, testConfig);
    expect(filtered.ranked.map((r) => r.id)).toEqual(["c0", "c2"]);
  });

  it("defaults to the top 10", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.5));
    const candidates = Array.from({ length: 25 }, (_v, i) => ({ id: `c${i}`, text: `text ${i}` }));

    const result = await rankTool.run(model, { query: "q", candidates }, testConfig);
    expect(result.ranked).toHaveLength(10);
    expect(result.total_candidates).toBe(25);
  });

  it("chunks oversized candidate sets, carrying the query into every chunk", async () => {
    const model = new FakeModel(relevanceResponder((text) => (text.startsWith("A") ? 0.9 : 0.1)));
    // ~8.7k tokens each: seven fit in 64k, so 20 needs three chunks.
    const big = (marker: string): string => marker + "x".repeat(30_000);
    const candidates = Array.from({ length: 20 }, (_v, i) => ({
      id: `c${i}`,
      text: big(i === 13 ? "A" : "B"),
    }));

    const result = await rankTool.run(model, { query: "how?", candidates, top_k: 3 }, testConfig);

    // Several fan-out batches plus one final deciding request.
    expect(result.chunks).toBeGreaterThan(2);
    expect(model.calls).toHaveLength(result.chunks);
    for (const call of model.calls) {
      expect((call.state as { query: string }).query).toBe("how?");
    }
    // Every candidate is judged exactly once across the fan-out (the final
    // request, the last call, re-judges only the batch winners).
    const fanout = model.calls.slice(0, -1);
    const judged = fanout.reduce(
      (total, call) => total + Object.keys(call.questions).filter((key) => key.startsWith("cand_")).length,
      0,
    );
    expect(judged).toBe(20);
    expect(result.total_candidates).toBe(20);
    expect(result.ranked[0]!.id).toBe("c13");
  });

  it("sums usage across the fan-out and the final request, and judges any_relevant once", async () => {
    const model = new FakeModel((request) => {
      const answers: Record<string, Answer> = {};
      let bestIndex = 0;
      for (const id of Object.keys(request.questions)) {
        if (id.startsWith("cand_")) answers[id] = noul(0.2);
        if (id === `cand_${bestIndex}`) bestIndex = Number(id.slice("cand_".length));
      }
      if (request.questions.which !== undefined) answers.which = choice("0", { "0": 1 }, 1);
      // Asked only in the final deciding request; not a max over the fan-out.
      if (request.questions.any_relevant !== undefined) answers.any_relevant = noul(0.93);
      return answers;
    });
    const candidates = Array.from({ length: 20 }, (_v, i) => ({
      id: `c${i}`,
      text: "y".repeat(30_000),
    }));

    const result = await rankTool.run(model, { query: "q", candidates }, testConfig);

    expect(result.chunks).toBeGreaterThan(2);
    expect(result.any_relevant).toBe(0.93);
    expect(result.usage.input_tokens).toBe(100 * result.chunks);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("names the candidate that cannot fit on its own", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.5));

    try {
      await rankTool.run(
        model,
        {
          query: "q",
          candidates: [
            { id: "ok", text: "short" },
            { id: "the-huge-one", text: "z".repeat(400_000) },
          ],
        },
        testConfig,
      );
      expect.unreachable("expected a BudgetError");
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetError);
      expect((error as Error).message).toContain('"the-huge-one"');
      expect((error as Error).message).toContain("Shorten or split");
    }
    expect(model.calls).toHaveLength(0);
  });

  it("folds extra instructions into every question", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.5));

    await rankTool.run(
      model,
      { query: "q", candidates: [{ id: "a", text: "t" }], instructions: "only API reference pages count" },
      testConfig,
    );

    const questions = model.calls[0]!.questions;
    expect(String(questions.cand_0!.instructions)).toContain("only API reference pages count");
    expect(String(questions.any_relevant!.instructions)).toContain("only API reference pages count");
  });

  it("asks one noul per candidate plus any_relevant, referencing the candidate by path", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.5));
    await rankTool.run(model, { query: "q", candidates: [{ id: "a", text: "t" }] }, testConfig);

    const questions = model.calls[0]!.questions;
    expect(questions.cand_0!.type).toBe("noul");
    expect(String(questions.cand_0!.instructions)).toContain("`candidates[0]`");
    expect(String(questions.cand_0!.instructions)).toContain("`query`");
  });

  it("scores a missing answer as 0 rather than throwing", async () => {
    const model = new FakeModel(() => ({ any_relevant: noul(0.4) }));
    const result = await rankTool.run(model, { query: "q", candidates: [{ id: "a", text: "t" }] }, testConfig);
    expect(result.ranked).toEqual([{ id: "a", relevance: 0, rank: 1, choice: 0 }]);
  });

  it("validates its input bounds", () => {
    expect(rankTool.inputSchema.safeParse({ query: "q", candidates: [] }).success).toBe(false);
    expect(
      rankTool.inputSchema.safeParse({
        query: "q",
        candidates: Array.from({ length: 501 }, () => ({ id: "a", text: "b" })),
      }).success,
    ).toBe(false);
    expect(rankTool.inputSchema.safeParse({ query: "", candidates: [{ id: "a", text: "b" }] }).success).toBe(false);
  });

  it("produces output that satisfies its output schema", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.5));
    const result = await rankTool.run(model, { query: "q", candidates: [{ id: "a", text: "t" }] }, testConfig);
    expect(rankTool.outputSchema.safeParse(result).success).toBe(true);
  });

  it("keeps descriptions compact", () => {
    expect(rankTool.description.length).toBeLessThanOrEqual(1200);
  });
});

describe("rank ordering helpers", () => {
  const entry = (index: number): rankTool.Entry => ({ id: `c${index}`, text: `t${index}`, index });

  it("choiceMargin is the top minus the runner-up, ignoring none", () => {
    expect(rankTool.choiceMargin({ "0": 0.6, "1": 0.3, none: 0.1 })).toBe(0.3);
    expect(rankTool.choiceMargin({ "0": 0.9 })).toBe(0.9);
    expect(rankTool.choiceMargin({})).toBe(0);
    // `none` never counts as the runner-up.
    expect(rankTool.choiceMargin({ "0": 0.5, none: 0.5 })).toBe(0.5);
  });

  it("orderRows puts finalists first by final choice, then the tail by relevance", () => {
    const e0 = entry(0);
    const e1 = entry(1);
    const e2 = entry(2);
    const e3 = entry(3);
    const all: rankTool.Placed[] = [
      { entry: e0, relevance: 0.4, choice: 0.1 },
      { entry: e1, relevance: 0.9, choice: 0.2 },
      { entry: e2, relevance: 0.2, choice: 0 },
      { entry: e3, relevance: 0.7, choice: 0 },
    ];
    const finalists = new Set([e0, e1]);
    const finalChoice = new Map([
      [e0, 0.8],
      [e1, 0.15],
    ]);
    const ordered = rankTool.orderRows(all, finalists, finalChoice);
    // Finalists by the deciding request's choice (e0 0.8 > e1 0.15), then the
    // tail (e3 0.7 > e2 0.2) by relevance. Finalists' choice is the final value.
    expect(ordered.map((row) => row.entry.id)).toEqual(["c0", "c1", "c3", "c2"]);
    expect(ordered[0]!.choice).toBe(0.8);
    expect(ordered[1]!.choice).toBe(0.15);
  });

  it("pickFinalists takes the top per request, trimmed to the budget", () => {
    const req = (indices: number[], choices: number[]) => ({
      scores: indices.map((i, k) => ({ entry: entry(i), relevance: 0.5, choice: choices[k] as number })),
    });
    const finalists = rankTool.pickFinalists(
      [req([0, 1, 2, 3], [0.1, 0.9, 0.5, 0.2]), req([4, 5], [0.8, 0.3])],
      "q",
      undefined,
    );
    // Top 3 of the first request by choice (1, 2, 3) plus both of the second (4, 5).
    expect(new Set(finalists.map((e) => e.id))).toEqual(new Set(["c1", "c2", "c3", "c4", "c5"]));
  });
});
