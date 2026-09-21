import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleStop } from "../../src/hooks/handlers/stop.js";
import type { HookInput } from "../../src/hooks/types.js";
import { choice, FakeModel, noul } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "jev-stopclaims-"));
  const g = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/**
 * A model that passes the stop-short check (nothing is admitted unfinished) so
 * the only thing that can block is the claim check, and answers any verify
 * `claim_N` as not_addressed (the diff neither states nor denies the claim).
 */
function passingStopModel(): FakeModel {
  return new FakeModel((call) => {
    if (call.questions.claims_complete !== undefined) {
      return {
        claims_complete: noul(0.95),
        says_part_not_done: noul(0.02),
        says_step_deferred: noul(0.02),
        says_check_failing: noul(0.02),
        asks_user: noul(0.02),
        addresses_request: noul(0.95),
        claims_verified: noul(0.5),
      };
    }
    const answers: Record<string, ReturnType<typeof choice>> = {};
    for (const id of Object.keys(call.questions)) {
      answers[id] = choice("not_addressed", { supported: 0.1, contradicted: 0.1, not_addressed: 0.8 }, 0.8);
    }
    return answers;
  });
}

function input(dir: string, message: string): HookInput {
  return {
    session_id: "s1",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: message,
    cwd: dir,
    background_tasks: [],
    session_crons: [],
  };
}

describe("handleStop with claim verification", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => cleanup(dataDir));

  it("blocks a final message that names a file the project does not have", async () => {
    const deps = makeDeps(dataDir, { model: passingStopModel() });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["add a parser module"] }));

    const output = await handleStop(input(repo, "Done. I created src/parser.ts with the new logic."), deps);
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("src/parser.ts");
    expect(output?.reason).toContain("[jev]");

    const log = deps.store.readSession("s1");
    expect(log.stop_blocks).toBe(1);
  });

  it("does not block when the named file really exists and is changed", async () => {
    // Change the tracked file so a claim about it is grounded.
    writeFileSync(join(repo, "app.ts"), "export const x = 2;\n");
    const deps = makeDeps(dataDir, { model: passingStopModel() });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["bump the constant"] }));

    const output = await handleStop(input(repo, "Done. I updated app.ts to bump the value."), deps);
    expect(output).toBeUndefined();
  });

  it("accepts a removal claim backed by a real deletion", async () => {
    rmSync(join(repo, "app.ts"));
    const deps = makeDeps(dataDir, { model: passingStopModel() });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["drop the old module"] }));

    const output = await handleStop(input(repo, "Done. I removed app.ts."), deps);
    expect(output).toBeUndefined();
  });

  it("runs stage 1 only when verify_claims is off, still catching a fabricated file", async () => {
    const deps = makeDeps(dataDir, { model: passingStopModel(), config: { verifyClaims: false } });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["add a parser module"] }));

    const output = await handleStop(
      input(repo, "Done. I created src/ghost.ts with the new parser and wired it in."),
      deps,
    );
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("src/ghost.ts");
    // Only the stop request went to the model; stage 2 verify never ran.
    expect((deps.model as FakeModel).calls).toHaveLength(1);
  });
});
