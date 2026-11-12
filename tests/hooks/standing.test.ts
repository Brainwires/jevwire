/**
 * Standing instructions: "keep going with X, and its release" still counts
 * after it falls out of the five-prompt window, until the user changes topic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Answer } from "../../src/decision/types.js";
import { gateRequest, handlePreToolUse } from "../../src/hooks/handlers/pre-tool-use.js";
import { handleUserPromptSubmit } from "../../src/hooks/handlers/user-prompt-submit.js";
import {
  isDirective,
  isTopicChange,
  MAX_DIRECTIVES_KEPT,
  nextDirectives,
  readDirectives,
  standingDirectives,
  standingTag,
} from "../../src/hooks/standing.js";
import type { Deps, HookInput } from "../../src/hooks/types.js";
import { FakeModel, noul, score } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

const NOW = 1_700_000_000_000;
const DIRECTIVE = "keep going with the jevwire fix, and its next release";

describe("isDirective / isTopicChange", () => {
  it("recognizes ongoing directives that name a task", () => {
    for (const prompt of [
      DIRECTIVE,
      "continue the migration of the auth module",
      "please take care of the flaky windows tests",
      "handle the release notes for 4.17 too",
      "finish the parser refactor and open the PR",
      "from now on run the linter before each commit",
    ]) {
      expect(isDirective(prompt), prompt).toBe(true);
    }
  });

  it("leaves out bare go-aheads and prompts with no directive in them", () => {
    for (const prompt of ["continue", "keep going", "yes", "what does this function return?", "rename foo to bar in utils.ts"]) {
      expect(isDirective(prompt), prompt).toBe(false);
    }
  });

  it("recognizes a topic change or a task declared done", () => {
    for (const prompt of ["new task: look at the docs site", "never mind that, check the CI", "ok that's done, thanks", "forget about it", "stop working on the parser"]) {
      expect(isTopicChange(prompt), prompt).toBe(true);
    }
    expect(isTopicChange("also bump the version")).toBe(false);
  });
});

describe("nextDirectives", () => {
  it("adds a directive, keeps it through unrelated prompts, and clears on a topic change", () => {
    let list = nextDirectives([], DIRECTIVE, 1, NOW);
    expect(list).toEqual([{ text: DIRECTIVE, seq: 1, ts: NOW }]);
    for (const [index, prompt] of ["what time is it in Tokyo?", "show me the CI status", "why is that job red"].entries()) {
      list = nextDirectives(list, prompt, index + 2, NOW);
    }
    expect(list).toHaveLength(1);
    expect(nextDirectives(list, "new task: write the blog post", 5, NOW)).toEqual([]);
  });

  it("lets the prompt that changes topic start a new standing instruction", () => {
    const list = nextDirectives([{ text: DIRECTIVE, seq: 1, ts: NOW }], "never mind that, keep going with the docs rewrite instead", 2, NOW);
    expect(list.map((d) => d.text)).toEqual(["never mind that, keep going with the docs rewrite instead"]);
  });

  it("forces a classifier-marked prompt in, dedupes a repeat, and caps the list", () => {
    expect(nextDirectives([], "rewrite the auth layer", 1, NOW, true)).toHaveLength(1);
    const twice = nextDirectives(nextDirectives([], DIRECTIVE, 1, NOW), DIRECTIVE, 2, NOW);
    expect(twice).toEqual([{ text: DIRECTIVE, seq: 2, ts: NOW }]);
    let many: ReturnType<typeof nextDirectives> = [];
    for (let i = 0; i < MAX_DIRECTIVES_KEPT + 5; i += 1) many = nextDirectives(many, `continue task number ${i} please`, i, NOW);
    expect(many).toHaveLength(MAX_DIRECTIVES_KEPT);
    expect(many.at(-1)?.text).toBe(`continue task number ${MAX_DIRECTIVES_KEPT + 4} please`);
  });

  it("validates what comes back off disk", () => {
    expect(readDirectives([{ text: "x", seq: 1, ts: 1 }, { text: 3 }, null, "y"])).toEqual([{ text: "x", seq: 1, ts: 1 }]);
    expect(readDirectives("nope")).toBeUndefined();
    expect(readDirectives([])).toBeUndefined();
  });
});

describe("standingDirectives", () => {
  const session = {
    prompts: ["show me the CI status", "why is that job red", "rerun it"],
    prompt_seq: 9,
    directives: [
      { text: "continue the docs rewrite for the 4.x pages", seq: 1, ts: NOW },
      { text: DIRECTIVE, seq: 2, ts: NOW },
      { text: "handle the windows runner registration too", seq: 6, ts: NOW },
      { text: "why is that job red", seq: 8, ts: NOW },
    ],
  };

  it("returns the newest N not already among the recent prompts, tagged with their age", () => {
    expect(standingDirectives(session, 2)).toEqual([
      { text: "handle the windows runner registration too", age: 3 },
      { text: DIRECTIVE, age: 7 },
    ]);
    expect(standingDirectives(session, 3)).toHaveLength(3);
    expect(standingDirectives(session, 0)).toEqual([]);
    expect(standingTag({ text: DIRECTIVE, age: 7 })).toBe(`[standing instruction from 7 prompts ago] ${DIRECTIVE}`);
    expect(standingTag({ text: "x", age: 1 })).toBe("[standing instruction from 1 prompt ago] x");
  });
});

describe("gateRequest with standing instructions", () => {
  it("puts them ahead of the recent prompts, oldest first, inside the budget", () => {
    const request = gateRequest(["look at the parser", "now fix the date test"], 4000, [
      { text: "handle the windows runner too", age: 3 },
      { text: DIRECTIVE, age: 7 },
    ]);
    expect(request).toEqual({
      latest: "now fix the date test",
      previous: [
        `[standing instruction from 7 prompts ago] ${DIRECTIVE}`,
        "[standing instruction from 3 prompts ago] handle the windows runner too",
        "look at the parser",
      ],
    });
  });

  it("drops standing instructions it has no room for rather than sending a fragment", () => {
    const request = gateRequest(["x".repeat(3950)], 4000, [{ text: DIRECTIVE, age: 7 }]);
    expect(request.previous).toEqual([]);
  });
});

function block(): Record<string, Answer> {
  const scope = score(0.02, ["unrelated", "ordinary step", "requested"], 0.9) as Answer & { probabilities?: Record<string, number> };
  scope.probabilities = { "0": 0.98, "1": 0.02, "2": 0 };
  return {
    destructive: noul(0.97),
    outward_facing: noul(0.97),
    credential_exposure: noul(0.02),
    mentions_target: noul(0.05),
    same_task_area: noul(0.02),
    scope,
    blast_radius: score(3, ["none", "local", "shared", "production"], 0.9),
  };
}

describe("end to end: prompts recorded, then a judged call", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  async function say(deps: Deps, prompt: string): Promise<void> {
    await handleUserPromptSubmit({ session_id: "s1", hook_event_name: "UserPromptSubmit", prompt }, deps);
  }

  const call: HookInput = {
    session_id: "s1",
    cwd: "/home/dev/project",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm publish" },
  };

  async function session(deps: Deps): Promise<void> {
    await say(deps, DIRECTIVE);
    for (const prompt of [
      "what does the CI dashboard say about the mac runners right now?",
      "and the windows ones, are they registered or still offline today?",
      "show me the last three failed jobs on the development branch please",
      "ok",
      "thanks",
    ]) {
      await say(deps, prompt);
    }
  }

  it("records the directive past the five-prompt window and sends it, tagged, to the scope judgment", async () => {
    const model = new FakeModel(block);
    const deps = makeDeps(dir, { model, now: NOW });
    await session(deps);
    const state = deps.store.readSession("s1");
    expect(state.prompts).not.toContain(DIRECTIVE);
    expect(state.prompt_seq).toBe(6);
    expect(state.directives?.map((d) => d.text)).toEqual([DIRECTIVE]);

    const output = await handlePreToolUse(call, deps);
    const request = (model.calls[0]?.state as { request: { previous: string[] } }).request;
    expect(request.previous[0]).toBe(`[standing instruction from 5 prompts ago] ${DIRECTIVE}`);

    // The trip names what scope was judged against, standing instruction included.
    const reason = output?.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(reason).toContain("the last 5 user prompts and 1 standing instruction from earlier");
    expect(reason).toContain('5 prompts ago: "keep going with the jevwire fix, and its next release"');
    expect(deps.store.readLog().at(-1)?.standing).toEqual([{ age: 5, text: DIRECTIVE }]);
  });

  it("forgets it after a topic change, and sends none when standing_directives is 0", async () => {
    const changed = new FakeModel(block);
    const deps = makeDeps(dir, { model: changed, now: NOW });
    await session(deps);
    await say(deps, "new task: look at the docs site build");
    await handlePreToolUse(call, deps);
    expect(JSON.stringify(changed.calls[0]?.state)).not.toContain("standing instruction");

    const other = tempDir();
    try {
      const off = new FakeModel(block);
      const offDeps = makeDeps(other, { model: off, now: NOW, config: { standingDirectives: 0 } });
      await session(offDeps);
      await handlePreToolUse(call, offDeps);
      expect(JSON.stringify(off.calls[0]?.state)).not.toContain("standing instruction");
    } finally {
      cleanup(other);
    }
  });

  it("never widens a subagent's task with the user's standing instructions", async () => {
    const model = new FakeModel(block);
    const deps = makeDeps(dir, { model, now: NOW });
    await session(deps);
    await handlePreToolUse(
      { ...call, tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "check the docs links" } },
      deps,
    );
    await handlePreToolUse({ ...call, agent_type: "general-purpose" }, deps);
    expect(JSON.stringify(model.calls[0]?.state)).not.toContain("standing instruction");
  });

  it("does not count a double-fired prompt twice", async () => {
    const deps = makeDeps(dir, { now: NOW });
    await say(deps, DIRECTIVE);
    await say(deps, DIRECTIVE);
    expect(deps.store.readSession("s1").prompt_seq).toBe(1);
  });
});
