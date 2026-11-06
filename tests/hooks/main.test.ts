/**
 * Dispatch and the fail-open path around it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HANDLERS, runEvent, WALL_CLOCK_MS } from "../../src/hooks/main.js";
import { FakeModel, noul, score } from "../helpers/fake-model.js";
import { CASES } from "./cases.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

const PRE = JSON.stringify({
  session_id: "s1",
  cwd: "/home/dev/project",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /" },
});

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  cleanup(dir);
});

describe("runEvent", () => {
  it("dispatches a known event", async () => {
    const output = await runEvent("PreToolUse", PRE, makeDeps(dir));
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(output?.hookSpecificOutput?.permissionDecisionReason).toContain("[jev] tripwire");
  });

  it("ignores an unknown event", async () => {
    expect(await runEvent("NoSuchEvent", PRE, makeDeps(dir))).toBeUndefined();
  });

  it("routes SubagentStop through the Stop handler", async () => {
    const model = new FakeModel(() => ({
      claims_complete: noul(0.1),
      says_part_not_done: noul(0.95),
      says_step_deferred: noul(0.02),
      says_check_failing: noul(0.02),
      asks_user: noul(0.02),
      addresses_request: noul(0.9),
    }));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["do the work"] }));
    const output = await runEvent(
      "SubagentStop",
      JSON.stringify({
        session_id: "s1",
        hook_event_name: "SubagentStop",
        stop_hook_active: false,
        last_assistant_message: "I got most of it done but the migration step is still outstanding.",
        background_tasks: [],
        session_crons: [],
      }),
      deps,
    );
    expect(output?.decision).toBe("block");
    expect(deps.store.readLog().at(-1)?.event).toBe("SubagentStop");
  });

  it("routes the Approval alias to bookkeeping only", async () => {
    const deps = makeDeps(dir);
    deps.store.rememberReissue("s1", { tool_use_id: "t1", ts: 0, tool_name: "Bash", trip_id: "t-aaaaaaaa" });
    const output = await runEvent(
      "Approval",
      JSON.stringify({ session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" }),
      deps,
    );
    expect(output).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("reissue-ran");
  });

  const garbage = ["", "   ", "not json", "{", "[]", "null", "42", '"a string"', '{"tool_name":'];
  for (const raw of garbage) {
    it(`survives ${JSON.stringify(raw)} on stdin`, async () => {
      expect(await runEvent("PreToolUse", raw, makeDeps(dir))).toBeUndefined();
    });
  }

  it("records a failed re-issue as failed, not as a run", async () => {
    const deps = makeDeps(dir);
    deps.store.rememberReissue("s1", { tool_use_id: "t1", ts: 0, tool_name: "Bash", trip_id: "t-aaaaaaaa" });
    await runEvent(
      "Approval",
      JSON.stringify({
        session_id: "s1",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_use_id: "t1",
        error: "Exit code 1",
      }),
      deps,
    );
    expect(deps.store.readLog().at(-1)?.decision).toBe("reissue-failed");
  });

  it("fills in the event name when stdin omits it", async () => {
    const deps = makeDeps(dir);
    const output = await runEvent(
      "PreToolUse",
      JSON.stringify({ session_id: "s1", cwd: "/x", tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
      deps,
    );
    expect(output?.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
  });

  it("tolerates a tool_input that is not an object", async () => {
    const deps = makeDeps(dir);
    expect(
      await runEvent("PreToolUse", JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: "ls" }), deps),
    ).toBeUndefined();
  });

  it("produces a serializable output and nothing else", async () => {
    // Destructive, and not part of anything the user asked for: a note.
    const model = new FakeModel(() => ({
      destructive: noul(0.99),
      outward_facing: noul(0.02),
      in_scope: noul(0.3),
      credential_exposure: noul(0.01),
      blast_radius: score(1, ["a", "b", "c", "d"], 0.9),
    }));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["clean up"] }));
    const output = await runEvent(
      "PreToolUse",
      JSON.stringify({
        session_id: "s1",
        cwd: "/home/dev/project",
        permission_mode: "default",
        tool_name: "Bash",
        tool_input: { command: "npm install" },
      }),
      deps,
    );
    const text = JSON.stringify(output);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["hookSpecificOutput"]);
  });
});

describe("the wall-clock budget", () => {
  it("leaves headroom under the 5 second hooks.json timeout", () => {
    expect(WALL_CLOCK_MS).toBeLessThan(5000);
    expect(WALL_CLOCK_MS).toBeGreaterThan(2000);
  });
});

/**
 * The command half of the conformance pair.
 *
 * `conformance.test.ts` runs the same table against a real daemon and asserts
 * byte equality with what happens here. This half pins what the bytes are, so a
 * change in behaviour fails as a changed expectation rather than as two paths
 * quietly agreeing on something new.
 */
describe("the shared case table, in process", () => {
  for (const hookCase of CASES) {
    it(hookCase.name, async () => {
      const deps = makeDeps(dir, {
        ...(hookCase.model !== undefined ? { model: hookCase.model() } : {}),
        ...(hookCase.config !== undefined ? { config: hookCase.config } : {}),
      });
      hookCase.prepare?.(deps.store);
      const output = await runEvent(hookCase.event, JSON.stringify(hookCase.input), deps);
      const text = JSON.stringify(output ?? {});
      if (hookCase.expect !== undefined) expect(text).toBe(hookCase.expect);
      for (const needle of hookCase.contains ?? []) expect(text).toContain(needle);
    });
  }
});

describe("HANDLERS", () => {
  it("is exported, so hooks.json and the daemon's routes can be checked against it", () => {
    // `Approval` is this repo's own label rather than a Claude Code event, and
    // the daemon exposes one route per key here, so it has to be in the map.
    expect(Object.keys(HANDLERS).sort()).toEqual(
      [
        "Approval",
        "PostToolUse",
        "PostToolUseFailure",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "SubagentStop",
        "UserPromptSubmit",
      ].sort(),
    );
  });
});
