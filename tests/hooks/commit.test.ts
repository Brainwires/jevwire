import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addedLinesOf, commitOutcome } from "../../src/hooks/commit-core.js";
import { isGitCommit } from "../../src/hooks/handlers/commit.js";
import { handlePreToolUse } from "../../src/hooks/handlers/pre-tool-use.js";
import type { HookInput } from "../../src/hooks/types.js";
import { choice, FakeModel, noul, score } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

const T = { auto: 0.85, review: 0.6 };

describe("commit-core", () => {
  it("addedLinesOf keeps + lines and drops the +++ header", () => {
    expect(addedLinesOf("+++ b/x\n+added\n-removed\n context")).toEqual(["+added"]);
  });

  it("commitOutcome: scope firm on level-3 mass, message note on firm no, secret trip on firm yes", () => {
    const out = commitOutcome(
      {
        pr_scope: score(2, ["one", "one+tweak", "several"], 0.9) as never,
        message_describes_diff: noul(0.1) as never,
        hardcodes_secret: noul(0.95) as never,
      },
      T,
    );
    // score() here has no per-level probabilities, so scope_p3 is undefined and
    // scopeNote is false — the note fires only on level-mass, never the expectation.
    expect(out.scope_p3).toBeUndefined();
    expect(out.messageNote).toBe(true);
    expect(out.secretTrip).toBe(true);
  });
});

describe("isGitCommit", () => {
  it("recognises a commit and rejects a dry run", () => {
    expect(isGitCommit('git commit -m "x"')).toBe(true);
    expect(isGitCommit("git commit --amend --no-edit")).toBe(true);
    expect(isGitCommit("git commit --dry-run")).toBe(false);
    expect(isGitCommit("git status")).toBe(false);
    expect(isGitCommit(undefined)).toBe(false);
  });
});

describe("handlePreToolUse commit branch", () => {
  let repo: string;
  let dataDir: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "jev-commit-"));
    dataDir = tempDir();
    const g = (...a: string[]): void => {
      execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    };
    g("init", "-q");
    g("config", "user.email", "t@e.com");
    g("config", "user.name", "t");
    writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    cleanup(dataDir);
  });

  const stage = (file: string, content: string): void => {
    writeFileSync(join(repo, file), content);
    execFileSync("git", ["add", file], { cwd: repo, stdio: "ignore" });
  };

  function commit(cmd: string): HookInput {
    return {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: cmd },
      tool_use_id: "toolu_c",
    };
  }

  /** Answer the commit questions from a map; scope via a Score with level probabilities. */
  function commitModel(opts: { scopeP3?: number; describes?: number; secret?: number }): FakeModel {
    return new FakeModel((call) => {
      const out: Record<string, ReturnType<typeof noul> | ReturnType<typeof choice>> = {};
      if (call.questions.pr_scope !== undefined) {
        const p3 = opts.scopeP3 ?? 0.05;
        out.pr_scope = { type: "score", score: 2 * p3, legend: {}, probabilities: { "0": 1 - p3, "1": 0, "2": p3 }, confidence: 0.9 };
      }
      if (call.questions.message_describes_diff !== undefined) out.message_describes_diff = noul(opts.describes ?? 0.95);
      if (call.questions.hardcodes_secret !== undefined) out.hardcodes_secret = noul(opts.secret ?? 0.02);
      return out;
    });
  }

  it("trips a secret written into the staged diff", async () => {
    stage("keys.ts", 'export const apiKey = "sk-live-abcdef0123456789xyz";\n');
    const deps = makeDeps(dataDir, { model: commitModel({ secret: 0.95 }) });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["commit the client"] }));
    const out = await handlePreToolUse(commit('git commit -m "add client"'), deps);
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain("hardcoded credential");
  });

  it("notes a diff scored as several independent changes", async () => {
    stage("a.ts", "export const a = 1;\n");
    const deps = makeDeps(dataDir, { model: commitModel({ scopeP3: 0.9 }) });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["commit"] }));
    const out = await handlePreToolUse(commit('git commit -m "stuff"'), deps);
    expect(out?.hookSpecificOutput?.additionalContext).toContain("several independent changes");
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("notes a commit message that does not describe the diff", async () => {
    stage("a.ts", "export const a = 1;\n");
    const deps = makeDeps(dataDir, { model: commitModel({ describes: 0.05 }) });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["commit"] }));
    const out = await handlePreToolUse(commit('git commit -m "unrelated"'), deps);
    expect(out?.hookSpecificOutput?.additionalContext).toContain("not fully described by its message");
  });

  it("is silent on a focused, well-described commit", async () => {
    stage("a.ts", "export const a = 1;\n");
    const deps = makeDeps(dataDir, { model: commitModel({}) });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["commit"] }));
    expect(await handlePreToolUse(commit('git commit -m "add a"'), deps)).toBeUndefined();
  });

  it("is silent when there is nothing staged", async () => {
    const model = commitModel({ scopeP3: 0.99 });
    const deps = makeDeps(dataDir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["commit"] }));
    expect(await handlePreToolUse(commit('git commit -m "empty"'), deps)).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });

  it("does nothing when lint is off", async () => {
    stage("keys.ts", 'const k = "sk-live-abcdef0123456789xyz";\n');
    const model = commitModel({ secret: 0.99 });
    const deps = makeDeps(dataDir, { model, config: { lint: "off" } });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["commit"] }));
    const out = await handlePreToolUse(commit('git commit -m "x"'), deps);
    // The commit check is off; a plain local commit is not a deny from the gate either.
    expect(out?.hookSpecificOutput?.permissionDecisionReason ?? "").not.toContain("hardcoded credential");
  });
});
