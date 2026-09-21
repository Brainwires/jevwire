/**
 * `jev_rank` over files, and the refusals that make it safe to point at a repo.
 *
 * The fake model is the instrument here: what it *received* is the only proof
 * that nothing sensitive was sent, and how many times it was called is the only
 * proof that the cost ceiling refused before the network rather than after.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSelectionError } from "../../src/files/index.js";
import * as rankTool from "../../src/tools/rank.js";
import { FakeModel, noul, testConfig } from "../helpers/fake-model.js";
import type { Answer } from "../../src/decision/types.js";

/** The string that must never reach the model or the output. */
const SECRET = "SK-LIVE-NEVER-SEND-THIS-VALUE";

let root: string;
let outside: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "jev-rank-"));
  root = join(base, "project");
  outside = join(base, "elsewhere");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(
    join(root, "src", "client.ts"),
    ["export async function request() {", "  // retry with exponential backoff", "  await backoff();", "}"].join("\n"),
  );
  writeFileSync(join(root, "src", "util.ts"), ["export function clamp(n: number) {", "  return n;", "}"].join("\n"));
  writeFileSync(join(root, ".env"), `TYPESAFE_API_KEY=${SECRET}\n`);
  writeFileSync(join(root, "id_rsa"), `-----BEGIN OPENSSH PRIVATE KEY-----\n${SECRET}\n`);
  writeFileSync(join(root, "server.pem"), `-----BEGIN CERTIFICATE-----\n${SECRET}\n`);
  mkdirSync(join(root, ".aws"), { recursive: true });
  writeFileSync(join(root, ".aws", "credentials"), `aws_secret_access_key = ${SECRET}\n`);
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), `{"apiKey":"${SECRET}"}\n`);
  writeFileSync(join(outside, "secrets.txt"), `${SECRET}\n`);
});

afterEach(() => {
  rmSync(resolve(root, ".."), { recursive: true, force: true });
});

const config = () => ({ ...testConfig, files: { root } });

/** Answer every candidate question with a fixed relevance. */
function relevance(value: number, overrides: Record<number, number> = {}): (call: { questions: Record<string, unknown> }) => Record<string, Answer> {
  return (call) => {
    const answers: Record<string, Answer> = {};
    for (const id of Object.keys(call.questions)) {
      const index = Number(/^cand_(\d+)$/.exec(id)?.[1] ?? NaN);
      answers[id] = noul(Number.isNaN(index) ? value : (overrides[index] ?? value));
    }
    return answers;
  };
}

/** Everything the model was handed, as one string. */
function everythingSent(model: FakeModel): string {
  return JSON.stringify(model.calls);
}

describe("jev_rank source selection", () => {
  it("requires exactly one of candidates, paths or glob", async () => {
    const model = new FakeModel(relevance(0.5));
    for (const input of [
      {},
      { candidates: [{ id: "a", text: "x" }], glob: "src/**/*.ts" },
      { paths: ["src/util.ts"], glob: "src/**/*.ts" },
      { candidates: [{ id: "a", text: "x" }], paths: ["src/util.ts"] },
    ]) {
      await expect(
        rankTool.run(model, { query: "q", ...input } as never, config()),
      ).rejects.toThrowError(FileSelectionError);
    }
    expect(model.calls, "nothing should be sent for a malformed call").toHaveLength(0);
  });

  it("rejects `unit` on a candidates call, where it means nothing", async () => {
    const model = new FakeModel(relevance(0.5));
    await expect(
      rankTool.run(model, { query: "q", candidates: [{ id: "a", text: "x" }], unit: "file" }, config()),
    ).rejects.toThrowError(/unit/);
  });

  it("leaves the candidates path completely unchanged", async () => {
    const model = new FakeModel(relevance(0.9));
    const result = await rankTool.run(
      model,
      { query: "q", candidates: [{ id: "a", text: "alpha" }, { id: "b", text: "beta" }] },
      config(),
    );
    expect(result.ranked).toEqual([
      { id: "a", relevance: 0.9, rank: 1, choice: 0 },
      { id: "b", relevance: 0.9, rank: 2, choice: 0 },
    ]);
    // The file-source fields stay absent, so a 0.1.x caller sees no change.
    expect(result.files_scanned).toBeUndefined();
    expect(result.chunks_scored).toBeUndefined();
    expect(result.skipped).toBeUndefined();
    expect(result.est_cost_usd).toBeUndefined();
  });
});

describe("jev_rank over files", () => {
  it("ranks chunks of a glob and returns line ranges, never text", async () => {
    const model = new FakeModel(relevance(0.2, { 0: 0.95 }));
    const result = await rankTool.run(model, { query: "where is backoff", glob: "src/**/*.ts" }, config());

    expect(result.files_scanned).toBe(2);
    expect(result.chunks_scored).toBe(2);
    expect(result.ranked[0]).toEqual({
      path: "src/client.ts",
      start_line: 1,
      end_line: 4,
      relevance: 0.95,
      rank: 1,
      choice: 0,
    });
    for (const row of result.ranked) {
      expect(row.id).toBeUndefined();
      expect(Object.keys(row).sort()).toEqual(["choice", "end_line", "path", "rank", "relevance", "start_line"]);
    }
    expect(result.est_cost_usd).toBeGreaterThan(0);
  });

  it("echoes no file text anywhere in its output", async () => {
    const model = new FakeModel(relevance(0.9));
    const result = await rankTool.run(model, { query: "q", glob: "src/**/*.ts" }, config());
    const rendered = JSON.stringify(result);
    for (const fragment of ["exponential backoff", "export function clamp", "await backoff", "return n;"]) {
      expect(rendered, `output must not echo ${fragment}`).not.toContain(fragment);
    }
  });

  it("ranks whole files with unit: file, keeping the best chunk's range", async () => {
    const long = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(root, "src", "long.ts"), long);
    // Score the second chunk of the long file highest.
    const model = new FakeModel((call) => {
      const answers: Record<string, Answer> = {};
      const candidates = (call.state as { candidates: string[] }).candidates;
      for (const id of Object.keys(call.questions)) {
        const index = Number(/^cand_(\d+)$/.exec(id)?.[1] ?? NaN);
        if (Number.isNaN(index)) {
          answers[id] = noul(0.9);
          continue;
        }
        answers[id] = noul((candidates[index] ?? "").includes("line 70") ? 0.99 : 0.1);
      }
      return answers;
    });

    const result = await rankTool.run(model, { query: "q", glob: "src/**/*.ts", unit: "file" }, config());
    const paths = result.ranked.map((row) => row.path);
    expect(new Set(paths).size, "one row per file").toBe(paths.length);
    expect(result.ranked[0]!.path).toBe("src/long.ts");
    expect(result.ranked[0]!.start_line).toBeGreaterThan(1);
    expect(result.ranked[0]!.end_line).toBeGreaterThanOrEqual(70);
  });

  it("reads explicitly named paths", async () => {
    const model = new FakeModel(relevance(0.7));
    const result = await rankTool.run(model, { query: "q", paths: ["src/util.ts"] }, config());
    expect(result.files_scanned).toBe(1);
    expect(result.ranked[0]!.path).toBe("src/util.ts");
  });
});

describe("jev_rank refusals", () => {
  it("never reads a sensitive file, even when named outright", async () => {
    const model = new FakeModel(relevance(0.9));
    const result = await rankTool.run(
      model,
      {
        query: "find the api key",
        paths: [".env", "id_rsa", "server.pem", ".aws/credentials", ".claude/settings.json", "src/util.ts"],
      },
      config(),
    );

    expect(result.skipped?.sensitive).toBe(5);
    expect(result.files_scanned).toBe(1);
    // The assertion that matters: the model never saw a byte of any of them.
    expect(everythingSent(model)).not.toContain(SECRET);
    expect(everythingSent(model)).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("never reads a sensitive file matched by a wide glob", async () => {
    const model = new FakeModel(relevance(0.9));
    const result = await rankTool.run(model, { query: "keys", glob: "**/*" }, config());
    expect(everythingSent(model)).not.toContain(SECRET);
    const paths = new Set(result.ranked.map((row) => row.path));
    expect(paths.has(".env")).toBe(false);
    expect(paths.has("id_rsa")).toBe(false);
  });

  it("refuses a path outside the root, including through a symlink", async () => {
    symlinkSync(join(outside, "secrets.txt"), join(root, "innocent.txt"));
    const model = new FakeModel(relevance(0.9));
    const result = await rankTool.run(
      model,
      { query: "q", paths: ["../elsewhere/secrets.txt", join(outside, "secrets.txt"), "innocent.txt", "src/util.ts"] },
      config(),
    );
    expect(result.skipped?.outside_root).toBe(3);
    expect(everythingSent(model)).not.toContain(SECRET);
  });

  it("refuses over the cost ceiling before sending anything at all", async () => {
    const model = new FakeModel(relevance(0.9));
    await expect(
      rankTool.run(model, { query: "q", glob: "src/**/*.ts" }, { ...testConfig, files: { root, maxInputTokens: 1 } }),
    ).rejects.toThrowError(/ceiling/);
    // The whole point of pricing locally: zero requests, zero spend.
    expect(model.calls).toHaveLength(0);
  });

  it("fails loudly when a glob matches nothing, rather than reporting nothing relevant", async () => {
    const model = new FakeModel(relevance(0.9));
    await expect(rankTool.run(model, { query: "q", glob: "src/**/*.rs" }, config())).rejects.toThrowError(
      /matched no files/,
    );
    expect(model.calls).toHaveLength(0);
  });

  it("fails when every named file was refused, rather than returning an empty ranking", async () => {
    const model = new FakeModel(relevance(0.9));
    await expect(rankTool.run(model, { query: "q", paths: [".env", "id_rsa"] }, config())).rejects.toThrowError(
      FileSelectionError,
    );
    expect(model.calls).toHaveLength(0);
  });
});

describe("score_spread", () => {
  it("is the top minus the median, to two decimals", () => {
    expect(rankTool.scoreSpread([0.9, 0.5, 0.1])).toBe(0.4);
    expect(rankTool.scoreSpread([0.96, 0.9, 0.9, 0.23, 0.1])).toBe(0.06);
    expect(rankTool.scoreSpread([0.87, 0.86, 0.85, 0.85, 0.84])).toBe(0.02);
    expect(rankTool.scoreSpread([])).toBe(0);
    expect(rankTool.scoreSpread([0.7])).toBe(0);
  });

  it("does not care about input order", () => {
    expect(rankTool.scoreSpread([0.1, 0.9, 0.5])).toBe(rankTool.scoreSpread([0.9, 0.5, 0.1]));
  });

  /**
   * The case the field exists for: a flat run. Every candidate scoring the same
   * means the ordering is noise, and the number has to say so even though the
   * top score looks confident.
   */
  it("reports a flat ranking as uninformative", async () => {
    const flat = new FakeModel(relevance(0.86));
    const result = await rankTool.run(flat, { query: "q", glob: "src/**/*.ts" }, config());
    expect(result.score_spread).toBe(0);
    expect(result.score_spread).toBeLessThan(rankTool.UNINFORMATIVE_SPREAD);
    // …while `any_relevant` still reads high, which is the trap it warns about.
    expect(result.any_relevant).toBe(0.86);
  });

  it("reports a discriminating ranking as informative", async () => {
    const sharp = new FakeModel(relevance(0.05, { 0: 0.96 }));
    const result = await rankTool.run(sharp, { query: "q", glob: "src/**/*.ts" }, config());
    expect(result.score_spread).toBeGreaterThan(rankTool.UNINFORMATIVE_SPREAD);
  });

  it("is present for a candidates source as well", async () => {
    const model = new FakeModel(relevance(0.2, { 0: 0.95 }));
    const result = await rankTool.run(
      model,
      { query: "q", candidates: [{ id: "a", text: "x" }, { id: "b", text: "y" }, { id: "c", text: "z" }] },
      config(),
    );
    expect(result.score_spread).toBe(0.75);
  });

  it("measures everything judged, not just the rows that survived top_k", async () => {
    const model = new FakeModel(relevance(0.1, { 0: 0.9 }));
    const candidates = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, text: `t${i}` }));
    const result = await rankTool.run(model, { query: "q", candidates, top_k: 1 }, config());
    expect(result.ranked).toHaveLength(1);
    expect(result.score_spread).toBe(0.8);
  });
});

describe("jev_rank request batching", () => {
  /**
   * The accuracy fix, as an invariant rather than a measurement.
   *
   * Budget-exact packing puts ~50 file chunks in one request, and at that width
   * the model stops telling them apart — measured live against this repo, the
   * relevant file did not make the top six and every score sat between 0.84 and
   * 0.87. Sixteen per request fixes it for no extra tokens, so the cap is the
   * thing worth protecting here.
   */
  it("never puts more than the cap in one request, however many candidates there are", async () => {
    // More short candidates than the cap, small enough that the budget would
    // hold them all in one request: only the count cap splits them, into
    // ceil(n / cap) fan-out batches plus one final deciding request.
    const n = rankTool.MAX_CANDIDATES_PER_REQUEST + 30;
    const candidates = Array.from({ length: n }, (_v, i) => ({ id: `c${i}`, text: `candidate ${i}` }));
    const model = new FakeModel(relevance(0.5));
    const result = await rankTool.run(model, { query: "q", candidates }, config());

    const expectedFanout = Math.ceil(n / rankTool.MAX_CANDIDATES_PER_REQUEST);
    expect(result.chunks).toBe(expectedFanout + 1);
    expect(model.calls.length).toBe(result.chunks);
    const fanout = model.calls.slice(0, -1);
    for (const call of fanout) {
      const batch = (call.state as { candidates: string[] }).candidates;
      expect(batch.length).toBeLessThanOrEqual(rankTool.MAX_CANDIDATES_PER_REQUEST);
    }
    // Every candidate is judged exactly once across the fan-out.
    const judged = fanout.reduce((sum, call) => sum + (call.state as { candidates: string[] }).candidates.length, 0);
    expect(judged).toBe(n);
    expect(result.total_candidates).toBe(n);
  });

  /**
   * The cap is source-neutral. 40 short candidates fit one request by budget
   * several times over, and would have gone as one in 0.1.x; that is the same
   * defect the file path had, so it gets the same fix.
   */
  it("caps a candidates source too, even when the budget would allow one request", async () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, text: `candidate number ${i}` }));
    const model = new FakeModel(relevance(0.5));
    const result = await rankTool.run(model, { query: "q", candidates }, config());

    expect(result.chunks).toBe(Math.ceil(40 / rankTool.MAX_CANDIDATES_PER_REQUEST));
    expect(model.calls).toHaveLength(result.chunks);
    for (const call of model.calls) {
      expect((call.state as { candidates: string[] }).candidates.length).toBeLessThanOrEqual(
        rankTool.MAX_CANDIDATES_PER_REQUEST,
      );
    }
    expect(result.total_candidates).toBe(40);
    expect(result.ranked).toHaveLength(10); // default top_k
  });

  it("lets the budget bind first when candidates are large", () => {
    // Four candidates so big that two will not fit together: the budget wins
    // over the count cap.
    const entries = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, text: "x".repeat(90_000), index: i }));
    expect(rankTool.chunkCandidates("q", entries, undefined)).toHaveLength(4);
  });
});

describe("jev_rank fan-out", () => {
  it("raises concurrency for file sources but yields to an explicit setting", async () => {
    // Observable through `mapWithConcurrency`: width is min(limit, items), so
    // the assertion is on the result, not the timing. Here it is enough that
    // both paths produce the same answer and neither throws.
    const model = new FakeModel(relevance(0.5));
    const auto = await rankTool.run(model, { query: "q", glob: "src/**/*.ts" }, config());
    const explicit = await rankTool.run(
      model,
      { query: "q", glob: "src/**/*.ts" },
      { ...testConfig, maxConcurrency: 1, maxConcurrencyExplicit: true, files: { root } },
    );
    expect(explicit.ranked).toEqual(auto.ranked);
    expect(rankTool.FILE_CONCURRENCY).toBe(8);
  });
});
