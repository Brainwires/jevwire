import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, MISSING_API_KEY_MESSAGE, type Config } from "../src/config.js";
import { JevValidationError } from "../src/jev/errors.js";
import { createServer } from "../src/server.js";
import type { DecisionModel } from "../src/decision/types.js";
import { choice, FakeModel, noul, score } from "./helpers/fake-model.js";

const TOOL_NAMES = [
  "jev_evaluate",
  "jev_rank",
  "jev_pick",
  "jev_verify",
  "jev_gate_action",
  "jev_next_step",
  "jev_list_models",
];

async function connect(model: DecisionModel | null, config: Config): Promise<Client> {
  const server = createServer(model, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const baseConfig = loadConfig({ TYPESAFE_API_KEY: "sk-secret-value-12345" });

describe("createServer", () => {
  let model: FakeModel;

  beforeEach(() => {
    model = new FakeModel(
      () => ({
        urgent: noul(0.93),
        team: choice("technical", { billing: 0.05, technical: 0.9, other: 0.05 }, 0.9),
        frustration: score(1.2, ["Calm", "Frustrated", "Angry"], 0.8),
      }),
      {
        models: [{ name: "jev-latest", description: "Flagship", release_date: "2026-09-01" }],
      },
    );
  });

  it("registers exactly the six tools, each with a description and schemas", async () => {
    const client = await connect(model, baseConfig);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());

    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.description!.length, `${tool.name} description length`).toBeLessThanOrEqual(1200);
      expect(tool.inputSchema, `${tool.name} needs an input schema`).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema, `${tool.name} needs an output schema`).toBeTruthy();
      expect(tool.outputSchema!.type).toBe("object");
    }
  });

  /**
   * A `$ref` in a tool's input schema is dropped or mishandled by some MCP
   * clients, so the structured-criteria union in `shared.ts` is deliberately
   * non-recursive: zod 4 then inlines it. This is the test that says so.
   */
  it("publishes input schemas with no $ref in them", async () => {
    const client = await connect(model, baseConfig);
    const { tools } = await client.listTools();
    for (const name of ["jev_evaluate", "jev_gate_action"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      expect(JSON.stringify(tool!.inputSchema), name).not.toContain("$ref");
    }
  });

  it("accepts jev_gate_action in both the string and the structured form", async () => {
    const gateModel = new FakeModel(() => ({
      destructive: noul(0.02),
      outward_facing: noul(0.02),
      credential_exposure: noul(0.01),
      mentions_target: noul(0.9),
      same_task_area: noul(0.9),
      scope: score(2, ["unrelated", "ordinary step", "requested"], 0.9),
      blast_radius: score(0, ["none", "local", "shared", "production"], 0.9),
    }));
    const client = await connect(gateModel, baseConfig);

    const asStrings = await client.callTool({
      name: "jev_gate_action",
      arguments: { action: "Bash(ls src)", user_request: "list the files in src" },
    });
    expect(asStrings.isError).toBeFalsy();

    const asObjects = await client.callTool({
      name: "jev_gate_action",
      arguments: {
        action: { tool: "Bash", command: "ls src", target_paths: ["src"] },
        user_request: { latest: "list the files in src", previous: ["what is in this repo?"] },
        context: { cwd: "/home/dev/project" },
      },
    });
    expect(asObjects.isError).toBeFalsy();
    expect((asObjects.structuredContent as { decision: string }).decision).toBe("allow");
    expect((asObjects.structuredContent as { scope: { requested: number } }).scope.requested).toBeGreaterThan(0.5);
  });

  it("calls jev_evaluate and returns structuredContent plus a JSON text block", async () => {
    const client = await connect(model, baseConfig);

    const result = await client.callTool({
      name: "jev_evaluate",
      arguments: {
        state: { ticket: "Payouts have been failing for 3 days" },
        questions: {
          urgent: { type: "noul", instructions: "Does `ticket` convey urgency?" },
          team: {
            type: "choice",
            instructions: "Which team should handle `ticket`?",
            criteria: { billing: "Payments", technical: "Bugs", other: "None of the above" },
          },
          frustration: {
            type: "score",
            instructions: "How frustrated is the customer in `ticket`?",
            criteria: ["Calm", "Frustrated", "Angry"],
          },
        },
      },
    });

    expect(result.isError).toBeFalsy();

    const structured = result.structuredContent as {
      answers: Record<string, { gate: string; verdict?: string }>;
      model: string;
      usage: { input_tokens: number };
      latency_ms: number;
    };
    expect(structured.answers.urgent).toMatchObject({ gate: "auto", verdict: "yes" });
    expect(structured.answers.team!.gate).toBe("auto");
    expect(structured.answers.frustration!.gate).toBe("review");
    expect(structured.model).toBe("fake-1.0.0");
    expect(structured.usage.input_tokens).toBe(100);
    expect(structured.latency_ms).toBe(7);

    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe("text");
    expect(JSON.parse(content[0]!.text)).toEqual(structured);

    // Only one request, even though three questions were asked.
    expect(model.calls).toHaveLength(1);
  });

  it("calls jev_list_models", async () => {
    const client = await connect(model, baseConfig);
    const result = await client.callTool({ name: "jev_list_models", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { models: unknown[] }).models).toEqual([
      { name: "jev-latest", description: "Flagship", release_date: "2026-09-01" },
    ]);
  });

  it("calls jev_gate_action end to end", async () => {
    const gateModel = new FakeModel(() => ({
      destructive: noul(0.98),
      outward_facing: noul(0.02),
      in_scope: noul(0.03),
      credential_exposure: noul(0.01),
      blast_radius: score(2.8, ["none", "local", "shared", "production"], 0.9),
    }));
    const client = await connect(gateModel, baseConfig);

    const result = await client.callTool({
      name: "jev_gate_action",
      arguments: { action: "Bash(rm -rf /)", user_request: "list the files in src" },
    });

    expect((result.structuredContent as { decision: string }).decision).toBe("block");
  });

  it("returns isError with an actionable message when no API key is configured", async () => {
    const config = loadConfig({});
    expect(config.apiKey).toBeNull();

    const client = await connect(null, config);

    // The server still starts and still advertises its tools.
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(7);

    for (const name of TOOL_NAMES) {
      const result = await client.callTool({
        name,
        arguments:
          name === "jev_evaluate"
            ? { state: "s", questions: { q: { type: "noul", instructions: "Is it urgent?" } } }
            : name === "jev_rank"
              ? { query: "q", candidates: [{ id: "a", text: "t" }] }
              : name === "jev_pick"
              ? { question: "q", candidates: [{ id: "a", text: "t" }, { id: "b", text: "u" }] }
              : name === "jev_verify"
                ? { claims: ["c"], evidence: "e" }
                : name === "jev_gate_action"
                  ? { action: "a", user_request: "r" }
                  : name === "jev_next_step"
                    ? { goal: "g", last_step: "s", result: "r" }
                    : {},
      });

      expect(result.isError, `${name} should report the missing key`).toBe(true);
      const content = result.content as { text: string }[];
      expect(content[0]!.text).toBe(MISSING_API_KEY_MESSAGE);
      expect(content[0]!.text).toContain("TYPESAFE_API_KEY");
    }
  });

  it("turns a thrown API error into a concise isError result", async () => {
    const angry = new FakeModel(() => {
      throw new JevValidationError("TypeSafe rejected the request body as invalid.", {
        status: 422,
        body: { detail: "questions.q.criteria: at least two options" },
      });
    });
    const client = await connect(angry, baseConfig);

    const result = await client.callTool({
      name: "jev_evaluate",
      arguments: { state: "s", questions: { q: { type: "noul", instructions: "Is it urgent?" } } },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain("HTTP 422");
    expect(text).toContain("at least two options");
    expect(text).not.toContain("at JevDecisionModel");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("never leaks the API key into an error message", async () => {
    const leaky = new FakeModel(() => {
      throw new Error(`upstream said: Bearer sk-secret-value-12345 is invalid`);
    });
    const client = await connect(leaky, baseConfig);

    const result = await client.callTool({
      name: "jev_evaluate",
      arguments: { state: "s", questions: { q: { type: "noul", instructions: "Is it urgent?" } } },
    });

    const text = (result.content as { text: string }[])[0]!.text;
    expect(result.isError).toBe(true);
    expect(text).not.toContain("sk-secret-value-12345");
    expect(text).toContain("[redacted]");
  });

  it("rejects input that does not match a tool's schema", async () => {
    const client = await connect(model, baseConfig);
    const result = await client.callTool({ name: "jev_verify", arguments: { claims: [], evidence: "e" } });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("claims");
    // The schema rejected it before the model was ever asked.
    expect(model.calls).toHaveLength(0);
  });
});


/**
 * The path-based tools over the real MCP transport, against a real temp
 * project.
 *
 * Everything else in this file exercises a tool through `createServer`; these
 * two go the whole way, because the file layer is reached through
 * `config.projectRoot` and a wiring mistake there would not show up in a unit
 * test of the tool.
 */
describe("createServer with path-based tools", () => {
  let root: string;

  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), "jev-server-")), "project");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "client.ts"),
      ["export async function request() {", "  // retry with exponential backoff", "  await backoff();", "}"].join("\n"),
    );
    writeFileSync(join(root, "src", "util.ts"), "export const clamp = (n: number) => n;\n");
    writeFileSync(join(root, "CHANGELOG.md"), ["# Changelog", "", "## 0.2.0", "", "- Added path-based tools."].join("\n"));
    writeFileSync(join(root, ".env"), "TYPESAFE_API_KEY=sk-must-never-be-read\n");
  });

  afterEach(() => {
    rmSync(resolve(root, ".."), { recursive: true, force: true });
  });

  const configFor = (dir: string): Config =>
    loadConfig({ TYPESAFE_API_KEY: "sk-secret-value-12345", CLAUDE_PROJECT_DIR: dir });

  it("calls jev_rank with a glob and returns line ranges, not text", async () => {
    const ranker = new FakeModel((call) => {
      const answers: Record<string, ReturnType<typeof noul>> = {};
      const candidates = (call.state as { candidates: string[] }).candidates;
      for (const id of Object.keys(call.questions)) {
        const index = Number(/^cand_(\d+)$/.exec(id)?.[1] ?? NaN);
        answers[id] = noul(
          Number.isNaN(index) ? 0.9 : (candidates[index] ?? "").includes("backoff") ? 0.96 : 0.08,
        );
      }
      return answers;
    });
    const client = await connect(ranker, configFor(root));

    const result = await client.callTool({
      name: "jev_rank",
      arguments: { query: "where are retries and backoff implemented", glob: "src/**/*.ts" },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      ranked: { path?: string; start_line?: number; end_line?: number; relevance: number; rank: number }[];
      files_scanned: number;
      chunks_scored: number;
      skipped: Record<string, number>;
      est_cost_usd: number;
    };

    expect(structured.files_scanned).toBe(2);
    expect(structured.chunks_scored).toBe(2);
    expect(structured.ranked[0]!.path).toBe("src/client.ts");
    expect(structured.ranked[0]!.start_line).toBe(1);
    expect(structured.ranked[0]!.rank).toBe(1);
    expect(structured.est_cost_usd).toBeGreaterThan(0);
    expect(structured.skipped.sensitive).toBe(0);

    // Neither rendering of the result carries a line of the files it read.
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).not.toContain("exponential backoff");
    expect(text).not.toContain("clamp");
    expect(JSON.stringify(structured)).not.toContain("await backoff");
  });

  it("calls jev_verify with evidence_path and reports where the answer came from", async () => {
    const verifier = new FakeModel((call) => {
      const answers: Record<string, ReturnType<typeof choice>> = {};
      for (const id of Object.keys(call.questions)) {
        answers[id] = choice("supported", { supported: 0.94, contradicted: 0.03, not_addressed: 0.03 }, 0.94);
      }
      return answers;
    });
    const client = await connect(verifier, configFor(root));

    const result = await client.callTool({
      name: "jev_verify",
      arguments: { claims: ["0.2.0 added path-based tools."], evidence_path: "CHANGELOG.md" },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      claims: { verdict: string; gate: string; where?: { start_line: number; end_line: number } }[];
      evidence_path: string;
      evidence_chunks: number;
      all_supported: boolean;
      summary: Record<string, number>;
    };

    expect(structured.evidence_path).toBe("CHANGELOG.md");
    expect(structured.evidence_chunks).toBe(1);
    expect(structured.claims[0]!.verdict).toBe("supported");
    expect(structured.claims[0]!.gate).toBe("auto");
    expect(structured.claims[0]!.where).toEqual({ start_line: 1, end_line: 5 });
    expect(structured.all_supported).toBe(true);
    expect(structured.summary.conflicting).toBe(0);
    // The server read the file; the claim text is all the caller had to send.
    expect(JSON.stringify(verifier.calls)).toContain("Added path-based tools");
  });

  it("refuses a sensitive evidence_path through the transport, with no model call", async () => {
    const verifier = new FakeModel(() => ({}));
    const client = await connect(verifier, configFor(root));

    const result = await client.callTool({
      name: "jev_verify",
      arguments: { claims: ["there is a key"], evidence_path: ".env" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain("credentials");
    expect(text).not.toContain("sk-must-never-be-read");
    expect(verifier.calls).toHaveLength(0);
  });

  it("reports a glob that matched nothing as an error, not an empty ranking", async () => {
    const ranker = new FakeModel(() => ({}));
    const client = await connect(ranker, configFor(root));

    const result = await client.callTool({
      name: "jev_rank",
      arguments: { query: "q", glob: "src/**/*.rs" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("matched no files");
    expect(ranker.calls).toHaveLength(0);
  });

  it("refuses two sources at once rather than guessing which one was meant", async () => {
    const ranker = new FakeModel(() => ({}));
    const client = await connect(ranker, configFor(root));

    const result = await client.callTool({
      name: "jev_rank",
      arguments: { query: "q", glob: "src/**/*.ts", candidates: [{ id: "a", text: "x" }] },
    });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("exactly one");
    expect(ranker.calls).toHaveLength(0);
  });
});
