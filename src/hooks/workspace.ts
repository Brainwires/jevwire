/**
 * The hook side's own small, refusing reader of the workspace.
 *
 * `src/files/` is the MCP tools' reader and the header there says `src/hooks/`
 * must never import it. That rule is about not pulling zod and the whole file
 * layer into the dependency-free `hook.mjs`, not about never reading a file
 * from a hook: the bundle already imports `node:fs` and `node:child_process`.
 * So the lint check (which needs the old content of a `Write`) and the stop
 * claim check (which needs `git diff HEAD` and whether a named file exists)
 * get a four-function reader here, with the same refusals `src/files/` makes:
 *
 *  - a path holding credentials is never read, whatever named it;
 *  - every path is resolved with `realpath` and must land inside the cwd, so
 *    `../`, an absolute path elsewhere, and a symlink out are one refusal;
 *  - files past a size cap are not read;
 *  - git runs through `execFile` with an args array (never a shell), a short
 *    timeout, a bounded buffer, and `GIT_EXTERNAL_DIFF`/`GIT_PAGER` stripped so
 *    a repo config cannot turn a diff into code execution.
 *
 * A static test (`tests/hooks/bundle.test.ts`) pins that no `src/hooks/**` file
 * imports `../files/`, so this stays the only hook-side reader.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isSensitivePath } from "../util/sensitive-path.js";

const run = promisify(execFile);

export interface WorkspaceLimits {
  maxFileBytes: number;
  gitTimeoutMs: number;
  maxDiffChars: number;
}

export const WORKSPACE_LIMITS: WorkspaceLimits = {
  maxFileBytes: 512 * 1024,
  gitTimeoutMs: 600,
  maxDiffChars: 40_000,
};

/** Bytes sniffed for a NUL before deciding a file is binary. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Resolve `rel` against `cwd` and say whether it lands inside.
 *
 * The cwd is realpath-resolved first (it must exist). The target is checked by
 * string containment, then — if it exists — realpath-resolved and checked again,
 * so a symlink pointing out of the tree is refused even though its own name is
 * inside.
 */
function insideCwd(cwd: string, rel: string): { ok: boolean; abs: string } {
  let root: string;
  try {
    root = realpathSync(resolve(cwd));
  } catch {
    return { ok: false, abs: "" };
  }
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  const contains = (path: string): boolean => path === root || path.startsWith(root + sep);
  if (!contains(abs)) return { ok: false, abs };
  try {
    const real = realpathSync(abs);
    return { ok: contains(real), abs: real };
  } catch {
    // Does not exist yet; the containment check above already held.
    return { ok: true, abs };
  }
}

/** Is a project-relative path a file that exists, is inside the cwd, and is not sensitive? */
export function projectFileExists(cwd: string, rel: string): "yes" | "no" | "refused" {
  if (isSensitivePath(rel)) return "refused";
  const { ok, abs } = insideCwd(cwd, rel);
  if (!ok) return "refused";
  if (isSensitivePath(abs)) return "refused";
  try {
    return existsSync(abs) && statSync(abs).isFile() ? "yes" : "no";
  } catch {
    return "no";
  }
}

export type ReadResult =
  | { kind: "text"; text: string }
  | { kind: "refused" | "missing" | "binary" | "too_large" };

/** Read a project file, refusing anything sensitive, outside, binary or too large. */
export function readProjectFile(cwd: string, rel: string, limits: WorkspaceLimits = WORKSPACE_LIMITS): ReadResult {
  if (isSensitivePath(rel)) return { kind: "refused" };
  const { ok, abs } = insideCwd(cwd, rel);
  if (!ok) return { kind: "refused" };
  if (isSensitivePath(abs)) return { kind: "refused" };
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return { kind: "missing" };
  }
  if (!stat.isFile()) return { kind: "missing" };
  if (stat.size > limits.maxFileBytes) return { kind: "too_large" };
  let buffer: Buffer;
  try {
    buffer = readFileSync(abs);
  } catch {
    return { kind: "missing" };
  }
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "binary" };
  return { kind: "text", text: buffer.toString("utf8") };
}

/** git's environment, with the hooks that could run code on a diff stripped. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_EXTERNAL_DIFF;
  env.GIT_PAGER = "";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

async function git(cwd: string, args: readonly string[], limits: WorkspaceLimits): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", args as string[], {
      cwd,
      timeout: limits.gitTimeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: gitEnv(),
      windowsHide: true,
    });
    return String(stdout);
  } catch {
    // Not a repo, git missing, timeout, or output over the buffer: fail open.
    return undefined;
  }
}

/**
 * Clamp a diff to `max` chars at a hunk or file boundary, so a truncated diff
 * is still parseable rather than cut mid-line.
 */
export function clampDiff(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  const boundary = Math.max(head.lastIndexOf("\ndiff --git "), head.lastIndexOf("\n@@ "));
  const cut = boundary > 0 ? boundary : head.lastIndexOf("\n");
  return { text: head.slice(0, cut > 0 ? cut : max), truncated: true };
}

/** `git diff HEAD` over the whole tree or named paths; undefined when not a repo. */
export async function gitDiffHead(
  cwd: string,
  paths?: readonly string[],
  limits: WorkspaceLimits = WORKSPACE_LIMITS,
): Promise<{ text: string; truncated: boolean } | undefined> {
  const args = ["diff", "HEAD", "--no-color", "--no-ext-diff", "-U3"];
  if (paths !== undefined && paths.length > 0) args.push("--", ...paths);
  const out = await git(cwd, args, limits);
  return out === undefined ? undefined : clampDiff(out, limits.maxDiffChars);
}

/** `git diff --cached` plus its `--stat`; undefined when not a repo. */
export async function gitStagedDiff(
  cwd: string,
  limits: WorkspaceLimits = WORKSPACE_LIMITS,
): Promise<{ text: string; stat: string; truncated: boolean } | undefined> {
  const out = await git(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", "-U3"], limits);
  if (out === undefined) return undefined;
  const stat = (await git(cwd, ["diff", "--cached", "--stat", "--no-color"], limits)) ?? "";
  const clamped = clampDiff(out, limits.maxDiffChars);
  return { text: clamped.text, stat: stat.slice(0, 4000), truncated: clamped.truncated };
}

export type NameStatus = "A" | "M" | "D" | "R";

/** `git diff HEAD --name-status` as a path -> status map; empty when not a repo. */
export async function gitNameStatus(
  cwd: string,
  limits: WorkspaceLimits = WORKSPACE_LIMITS,
): Promise<Map<string, NameStatus>> {
  const out = await git(cwd, ["diff", "HEAD", "--name-status", "--no-color"], limits);
  const map = new Map<string, NameStatus>();
  if (out === undefined) return map;
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    const code = parts[0]?.trim();
    if (code === undefined || code === "") continue;
    const letter = code[0] as string;
    if (letter !== "A" && letter !== "M" && letter !== "D" && letter !== "R") continue;
    // A rename is "R100\told\tnew"; the new path is what exists now.
    const path = letter === "R" ? parts[2] : parts[1];
    if (path !== undefined && path !== "") map.set(path, letter);
  }
  return map;
}
