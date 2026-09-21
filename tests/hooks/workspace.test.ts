import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clampDiff,
  gitDiffHead,
  gitNameStatus,
  gitStagedDiff,
  WORKSPACE_LIMITS,
  projectFileExists,
  readProjectFile,
} from "../../src/hooks/workspace.js";

// A generous git timeout so these real-repo tests do not flake under heavy
// parallel CI load; production keeps the 1500 ms default.
const L = { ...WORKSPACE_LIMITS, gitTimeoutMs: 30_000 };

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "jev-ws-"));
  root = join(base, "project");
  outside = join(base, "elsewhere");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const x = 1;\n");
  writeFileSync(join(root, ".env"), "TYPESAFE_API_KEY=SECRET\n");
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("readProjectFile", () => {
  it("reads a normal project file", () => {
    expect(readProjectFile(root, "src/app.ts")).toEqual({ kind: "text", text: "export const x = 1;\n" });
  });

  it("refuses a credentials file however it is named", () => {
    expect(readProjectFile(root, ".env").kind).toBe("refused");
    expect(readProjectFile(root, "./.env").kind).toBe("refused");
  });

  it("refuses a path that escapes the cwd with ..", () => {
    expect(readProjectFile(root, "../elsewhere/secret.txt").kind).toBe("refused");
    expect(readProjectFile(root, resolve(outside, "secret.txt")).kind).toBe("refused");
  });

  it("refuses a symlink that points outside the cwd", () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "link.ts"));
    expect(readProjectFile(root, "src/link.ts").kind).toBe("refused");
  });

  it("reports a missing file", () => {
    expect(readProjectFile(root, "src/nope.ts").kind).toBe("missing");
  });

  it("refuses a file over the size cap", () => {
    writeFileSync(join(root, "src", "big.ts"), "x".repeat(2000));
    expect(readProjectFile(root, "src/big.ts", { maxFileBytes: 1000, gitTimeoutMs: 600, maxDiffChars: 40_000 }).kind).toBe(
      "too_large",
    );
  });

  it("refuses a binary file", () => {
    writeFileSync(join(root, "src", "bin"), Buffer.from([1, 2, 0, 3, 4]));
    expect(readProjectFile(root, "src/bin").kind).toBe("binary");
  });
});

describe("projectFileExists", () => {
  it("answers yes / no / refused", () => {
    expect(projectFileExists(root, "src/app.ts")).toBe("yes");
    expect(projectFileExists(root, "src/nope.ts")).toBe("no");
    expect(projectFileExists(root, ".env")).toBe("refused");
    expect(projectFileExists(root, "../elsewhere/secret.txt")).toBe("refused");
  });
});

describe("clampDiff", () => {
  it("leaves a short diff alone", () => {
    expect(clampDiff("small", 100)).toEqual({ text: "small", truncated: false });
  });

  it("cuts at a hunk boundary and flags truncation", () => {
    const diff = `diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n@@ -1 +1 @@\n-c\n+d\n`;
    const out = clampDiff(diff, 40);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(40);
    // Cut at a boundary, so the kept text ends cleanly.
    expect(out.text.endsWith("\n") || out.text.length === 0 || /@@|diff --git/.test(out.text)).toBe(true);
  });
});

describe("git readers", () => {
  it("returns undefined outside a repository", async () => {
    expect(await gitDiffHead(root)).toBeUndefined();
    expect(await gitStagedDiff(root)).toBeUndefined();
    expect((await gitNameStatus(root)).size).toBe(0);
  });

  it("reads HEAD diff, staged diff and name-status in a real repo", async () => {
    const g = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    };
    g("init", "-q");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    g("add", "src/app.ts");
    g("commit", "-q", "-m", "init");

    writeFileSync(join(root, "src", "app.ts"), "export const x = 2;\n");
    const head = await gitDiffHead(root, undefined, L);
    expect(head?.text).toContain("export const x");
    expect(head?.text).toContain("+export const x = 2;");

    g("add", "src/app.ts");
    const staged = await gitStagedDiff(root, L);
    expect(staged?.text).toContain("+export const x = 2;");
    expect(staged?.stat).toContain("app.ts");

    const status = await gitNameStatus(root, L);
    expect(status.get("src/app.ts")).toBe("M");
  });

  it("sees an added file as A and a removed file as D", async () => {
    const g = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    };
    g("init", "-q");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    writeFileSync(join(root, "src", "old.ts"), "old\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    rmSync(join(root, "src", "old.ts"));
    writeFileSync(join(root, "src", "new.ts"), "new\n");

    const status = await gitNameStatus(root, L);
    expect(status.get("src/old.ts")).toBe("D");
    // A brand-new untracked file is not in `git diff HEAD` until added.
    g("add", "src/new.ts");
    expect((await gitNameStatus(root, L)).get("src/new.ts")).toBe("A");
  });
});
