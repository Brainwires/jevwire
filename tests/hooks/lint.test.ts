import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handlePreToolUse } from "../../src/hooks/handlers/pre-tool-use.js";
import { clearConventionsCache } from "../../src/hooks/conventions.js";
import type { HookInput } from "../../src/hooks/types.js";
import { FakeModel, noul } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

let repo: string;
let dataDir: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "jev-lint-"));
  dataDir = tempDir();
  clearConventionsCache();
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  cleanup(dataDir);
});

/** Answer the gated lint questions from a fixed map; anything else is a firm no. */
function lintModel(answers: Record<string, number>): FakeModel {
  return new FakeModel((call) => {
    const out: Record<string, ReturnType<typeof noul>> = {};
    for (const id of Object.keys(call.questions)) out[id] = noul(answers[id] ?? 0.02);
    return out;
  });
}

function edit(file: string, oldStr: string, newStr: string): HookInput {
  return {
    session_id: "s1",
    hook_event_name: "PreToolUse",
    cwd: repo,
    tool_name: "Edit",
    tool_input: { file_path: join(repo, file), old_string: oldStr, new_string: newStr },
    tool_use_id: "toolu_1",
  };
}

describe("handlePreToolUse lint branch", () => {
  it("trips a hardcoded secret with a deny", async () => {
    const deps = makeDeps(dataDir, { model: lintModel({ hardcodes_secret: 0.95 }) });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["wire up the client"] }));
    const out = await handlePreToolUse(edit("client.ts", "const c = {}", 'const apiKey = "sk-live-abcdef0123456789"'), deps);
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain("tripwire");
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain("credential");
  });

  it("notes a swallowed exception without denying", async () => {
    const deps = makeDeps(dataDir, { model: lintModel({ swallows_exception: 0.9 }) });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["add the fetch"] }));
    const out = await handlePreToolUse(
      edit("fetch.ts", "doThing()", "try { doThing() } catch (e) {}"),
      deps,
    );
    expect(out?.hookSpecificOutput?.additionalContext).toContain("catches an error and discards it");
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("stays silent when nothing is firm", async () => {
    const deps = makeDeps(dataDir, { model: lintModel({ swallows_exception: 0.3 }) });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["x"] }));
    expect(await handlePreToolUse(edit("f.ts", "a()", "try { a() } catch (e) {}"), deps)).toBeUndefined();
  });

  it("notes rather than trips a removed test the user asked to remove", async () => {
    const deps = makeDeps(dataDir, { model: lintModel({ removes_test: 0.92, requested_removal: 0.95 }) });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["delete the flaky expect in foo.test.ts"] }));
    const out = await handlePreToolUse(edit("foo.test.ts", "expect(x).toBe(1)\nrun()", "run()"), deps);
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(out?.hookSpecificOutput?.additionalContext).toContain("test or assertion");
  });

  it("trips a removed test the user did not ask to remove, then passes on sidecar affirm + re-issue", async () => {
    const deps = makeDeps(dataDir, { model: lintModel({ removes_test: 0.93, requested_removal: 0.05 }) });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["speed up the suite"] }));
    const call = edit("foo.test.ts", "expect(x).toBe(1)\nrun()", "run()");
    const trip = await handlePreToolUse(call, deps);
    expect(trip?.hookSpecificOutput?.permissionDecision).toBe("deny");
    const id = (trip?.hookSpecificOutput?.permissionDecisionReason ?? "").match(/t-[0-9a-f]{8}/)?.[0] as string;

    // The sidecar affirmation is a separate Bash `true # jev:intended t-…`.
    const affirm = await handlePreToolUse(
      { session_id: "s1", hook_event_name: "PreToolUse", cwd: repo, tool_name: "Bash", tool_input: { command: `true # jev:intended ${id}: the user asked to speed up the suite` } },
      deps,
    );
    expect(affirm).toBeUndefined();

    // Re-issuing the same edit now passes silently.
    expect(await handlePreToolUse(call, deps)).toBeUndefined();
  });

  it("skips a whitespace-only edit with no model call", async () => {
    const model = lintModel({});
    const deps = makeDeps(dataDir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["reformat"] }));
    expect(await handlePreToolUse(edit("f.ts", "const x=1", "const  x = 1"), deps)).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });

  it("does nothing when lint is off", async () => {
    const model = lintModel({ hardcodes_secret: 0.99 });
    const deps = makeDeps(dataDir, { model, config: { lint: "off" } });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["x"] }));
    expect(await handlePreToolUse(edit("f.ts", "a", 'const k = "sk-live-abcdef0123456789xyz"'), deps)).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });

  it("reads the current file for a Write so a rewrite's removed test is seen", async () => {
    writeFileSync(join(repo, "bar.test.ts"), "expect(y).toBe(2)\nkeep()\n");
    const deps = makeDeps(dataDir, { model: lintModel({ removes_test: 0.93, requested_removal: 0.04 }) });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["rewrite bar"] }));
    const out = await handlePreToolUse(
      { session_id: "s1", hook_event_name: "PreToolUse", cwd: repo, tool_name: "Write", tool_input: { file_path: join(repo, "bar.test.ts"), content: "keep()\n" }, tool_use_id: "t2" },
      deps,
    );
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
