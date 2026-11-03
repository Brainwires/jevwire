/**
 * Reading the caller's files on the caller's behalf.
 *
 * This layer exists so that the expensive half of a retrieval — shipping file
 * text through a model that then rejects most of it — happens once, here,
 * instead of twice through the calling LLM's context. The tools above it hand
 * back `path:start-end` and a score; the text never goes back out.
 *
 * Used by the MCP tools only. `src/hooks/` must never import it: a permission
 * hook that read files would be both slow and a much larger attack surface
 * than a hook that reads a tool call.
 *
 * The rules are all refusals, and they are deliberately ordered so that the
 * strongest one wins:
 *
 *  1. A path holding credentials is never read, however it was named — a
 *     literal path, a glob match, or a symlink. Refusing only globbed matches
 *     would make `paths: [".env"]` the bypass.
 *  2. Every path is resolved with `realpath` and must land inside the root, so
 *     `../`, an absolute path elsewhere, and a symlink pointing out are all the
 *     same refusal.
 *  3. Nothing is sent until the whole selection is priced, so a request that
 *     would cost too much costs nothing.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative as relativePath, resolve, sep } from "node:path";
import { estimateTokens } from "../decision/budget.js";
import { estimateCostUsd } from "../decision/pricing.js";
import { isSensitivePath } from "../util/sensitive-path.js";
import { FileSelectionError } from "./errors.js";
import { DEFAULT_IGNORED_DIRS, globFiles, isIgnoredFile } from "./glob.js";

export { FileSelectionError } from "./errors.js";
export type { FileErrorKind } from "./errors.js";
export { globFiles, matchPath } from "./glob.js";

/** Files larger than this are someone else's problem. */
export const MAX_FILE_BYTES = 512 * 1024;
/** A glob may not fan out past this. */
export const MAX_FILES = 1000;
/** Lines per chunk, and how many lines two neighbours share. */
export const CHUNK_LINES = 60;
export const CHUNK_OVERLAP_LINES = 5;
/** A chunk longer than this is split again, so one huge line cannot dominate. */
export const MAX_CHUNK_CHARS = 6000;
/** Hard ceiling for one tool call: ~$0.13 at $0.042/Mtok. */
export const MAX_INPUT_TOKENS = 3_000_000;
/**
 * Tokens each chunk costs beyond its own text: one Noul question, repeated in
 * whichever request the chunk lands in. Measured against the rank tool's
 * question, rounded up.
 */
export const PER_CHUNK_OVERHEAD_TOKENS = 90;
/** Bytes examined when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8192;

export interface SkippedCounts {
  binary: number;
  too_large: number;
  sensitive: number;
  outside_root: number;
  /** A named path that is not there, or is not a file. */
  not_found: number;
  /** Generated output: lockfiles, `*.min.*`, sourcemaps, ignored directories. */
  ignored: number;
}

export function emptySkipped(): SkippedCounts {
  return { binary: 0, too_large: 0, sensitive: 0, outside_root: 0, not_found: 0, ignored: 0 };
}

export function skippedTotal(skipped: SkippedCounts): number {
  return Object.values(skipped).reduce((a, b) => a + b, 0);
}

export interface FileChunk {
  /** Relative to the root, `/`-separated. */
  path: string;
  /** 1-based, inclusive. */
  start_line: number;
  end_line: number;
  text: string;
}

export interface FileAccessOptions {
  /** Defaults to `CLAUDE_PROJECT_DIR`, else the process cwd. */
  root?: string | undefined;
  maxFileBytes?: number | undefined;
  maxFiles?: number | undefined;
  chunkLines?: number | undefined;
  overlapLines?: number | undefined;
  maxChunkChars?: number | undefined;
  maxInputTokens?: number | undefined;
  /** Applied to glob matches; an explicitly named path is honoured. */
  ignoredDirs?: Set<string> | undefined;
  /** Ceiling on directories a glob may enter. */
  maxDirs?: number | undefined;
  /** Ceiling on directory entries a glob may look at. */
  maxVisited?: number | undefined;
}

export interface FileSelection {
  chunks: FileChunk[];
  /** Files whose content was actually read and chunked. */
  files_scanned: number;
  skipped: SkippedCounts;
  est_input_tokens: number;
  est_cost_usd: number;
  /** Absolute, realpath-resolved project root the paths are relative to. */
  root: string;
}

// ------------------------------------------------------------------- the root

/**
 * The project root. `CLAUDE_PROJECT_DIR` is what Claude Code exports to a
 * plugin's MCP server; a bare `npx @brainwires/jevwire` has only its cwd.
 *
 * Resolved through `realpath` so that a root reached by a symlink — `/tmp` on
 * macOS is `/private/tmp`, and every temp-dir test hits this — does not make
 * every path under it look like an escape.
 */
export function resolveProjectRoot(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = env.CLAUDE_PROJECT_DIR?.trim();
  const base = configured !== undefined && configured !== "" ? configured : cwd;
  try {
    return realpathSync(resolve(base));
  } catch {
    return resolve(base);
  }
}

/**
 * Canonicalize whatever root the caller supplied.
 *
 * Every containment check compares against a `realpath`, so the root has to be
 * one too or nothing inside it matches. Callers hand over `CLAUDE_PROJECT_DIR`,
 * a cwd, or a test's temp directory, and on macOS every one of those can arrive
 * with a symlinked prefix. Canonicalizing here means no caller has to know.
 */
export function rootOf(options: FileAccessOptions = {}): string {
  if (options.root === undefined || options.root === "") return resolveProjectRoot();
  try {
    return realpathSync(resolve(options.root));
  } catch {
    return resolve(options.root);
  }
}

function isInsideRoot(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

export type Resolution =
  | { kind: "ok"; absolute: string; relative: string }
  | { kind: "sensitive" }
  | { kind: "outside_root" }
  | { kind: "not_found" };

/**
 * Resolve one caller-supplied path against the root.
 *
 * The sensitivity check runs three times on purpose: on the string the caller
 * wrote, on the lexically resolved path, and on the path `realpath` returned.
 * A symlink named innocently is the case the third one catches.
 */
export function resolveInsideRoot(root: string, input: string): Resolution {
  if (input.trim() === "") return { kind: "not_found" };
  if (isSensitivePath(input)) return { kind: "sensitive" };

  const lexical = isAbsolute(input) ? resolve(input) : resolve(root, input);
  if (isSensitivePath(relativePath(root, lexical))) return { kind: "sensitive" };

  let real: string;
  try {
    real = realpathSync(lexical);
  } catch {
    // Nothing there to resolve. The lexical answer is the best available, and
    // it only decides which of two refusals to report.
    return isInsideRoot(root, lexical) ? { kind: "not_found" } : { kind: "outside_root" };
  }
  /**
   * The containment check, and the only one that counts. It deliberately runs
   * on the `realpath` rather than the lexical path, because both directions
   * matter: a symlink pointing out of the root must be refused even though it
   * looks inside, and a caller naming an absolute path through a symlinked
   * prefix (`/tmp/p` for `/private/tmp/p`, which is every macOS temp dir) must
   * be accepted even though it looks outside.
   */
  if (!isInsideRoot(root, real)) return { kind: "outside_root" };
  const rel = relativePath(root, real).split(sep).join("/");
  if (isSensitivePath(rel)) return { kind: "sensitive" };

  try {
    if (!statSync(real).isFile()) return { kind: "not_found" };
  } catch {
    return { kind: "not_found" };
  }
  return { kind: "ok", absolute: real, relative: rel };
}

// ---------------------------------------------------------------- the reading

export type ReadOutcome =
  | { kind: "ok"; text: string }
  | { kind: "binary" }
  | { kind: "too_large" }
  | { kind: "not_found" };

/** True when the first few KB contain a NUL byte. */
export function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function readTextFile(absolute: string, maxBytes: number = MAX_FILE_BYTES): ReadOutcome {
  let size: number;
  try {
    size = statSync(absolute).size;
  } catch {
    return { kind: "not_found" };
  }
  // Checked before the read, so an oversized file is never held in memory.
  if (size > maxBytes) return { kind: "too_large" };
  let buffer: Buffer;
  try {
    buffer = readFileSync(absolute);
  } catch {
    return { kind: "not_found" };
  }
  if (looksBinary(buffer)) return { kind: "binary" };
  return { kind: "ok", text: buffer.toString("utf8") };
}

// --------------------------------------------------------------- the chunking

/**
 * Split text into overlapping line ranges.
 *
 * Line-based because the output is a line range a human or an editor can open.
 * The overlap is there so that a definition and its use do not land on
 * opposite sides of a boundary and score badly in both chunks.
 *
 * One exception to "never split mid-line": a single line longer than
 * `maxChunkChars` is cut at character boundaries into several chunks that all
 * carry that same line number. The line numbering stays honest — every piece
 * really is on that line — and the alternative is failing on a legitimate file
 * with one very long line.
 */
export function chunkText(path: string, text: string, options: FileAccessOptions = {}): FileChunk[] {
  const chunkLines = options.chunkLines ?? CHUNK_LINES;
  const overlap = Math.min(options.overlapLines ?? CHUNK_OVERLAP_LINES, chunkLines - 1);
  const maxChars = options.maxChunkChars ?? MAX_CHUNK_CHARS;
  const step = Math.max(1, chunkLines - overlap);

  const lines = text.split("\n");
  const out: FileChunk[] = [];

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + chunkLines, lines.length);
    pushRange(out, path, lines, start, end, maxChars);
    if (end >= lines.length) break;
  }

  return out.filter((chunk) => chunk.text.trim() !== "");
}

/** Emit `[start, end)` as one chunk, subdividing while it is over the cap. */
function pushRange(
  out: FileChunk[],
  path: string,
  lines: readonly string[],
  start: number,
  end: number,
  maxChars: number,
): void {
  const text = lines.slice(start, end).join("\n");
  if (text.length <= maxChars) {
    out.push({ path, start_line: start + 1, end_line: end, text });
    return;
  }
  if (end - start > 1) {
    const middle = start + Math.ceil((end - start) / 2);
    pushRange(out, path, lines, start, middle, maxChars);
    pushRange(out, path, lines, middle, end, maxChars);
    return;
  }
  // One line, over the cap: cut it into pieces that keep its line number.
  for (let offset = 0; offset < text.length; offset += maxChars) {
    out.push({
      path,
      start_line: start + 1,
      end_line: end,
      text: text.slice(offset, offset + maxChars),
    });
  }
}

// -------------------------------------------------------------- the selection

/** Tokens a selection of chunks will cost as input, questions included. */
export function estimateSelectionTokens(chunks: readonly FileChunk[]): number {
  let tokens = 0;
  for (const chunk of chunks) tokens += estimateTokens(chunk.text) + PER_CHUNK_OVERHEAD_TOKENS;
  return tokens;
}

/** Expand a glob to relative paths, or fail with a message the caller can act on. */
export function expandGlob(
  pattern: string,
  options: FileAccessOptions = {},
): { paths: string[]; ignored: number; outsideRoot: number } {
  const root = rootOf(options);
  const limit = options.maxFiles ?? MAX_FILES;
  const globOptions: Parameters<typeof globFiles>[1] = { root, limit };
  if (options.ignoredDirs !== undefined) globOptions.ignoredDirs = options.ignoredDirs;
  else globOptions.ignoredDirs = DEFAULT_IGNORED_DIRS;
  if (options.maxDirs !== undefined) globOptions.maxDirs = options.maxDirs;
  if (options.maxVisited !== undefined) globOptions.maxVisited = options.maxVisited;
  const result = globFiles(pattern, globOptions);

  if (result.truncated) {
    throw new FileSelectionError(
      "too_many_matches",
      `The glob ${JSON.stringify(pattern)} matches more than ${limit} files. Narrow it — name a subdirectory, ` +
        `a single extension, or fewer \`**\` levels — and call again.`,
    );
  }
  if (result.paths.length === 0) {
    throw new FileSelectionError(
      "no_matches",
      `The glob ${JSON.stringify(pattern)} matched no files under ${root}. ` +
        `Paths are relative to the project root; check the pattern, and note that ` +
        `${[...DEFAULT_IGNORED_DIRS].slice(0, 5).join(", ")} and generated files are not scanned.`,
    );
  }
  return { paths: result.paths, ignored: result.ignored, outsideRoot: result.outsideRoot };
}

export interface CollectInput {
  /** Exactly one of these. */
  paths?: readonly string[] | undefined;
  glob?: string | undefined;
}

/**
 * Turn paths or a glob into priced chunks.
 *
 * Nothing here talks to a model; it is all local, so the cost ceiling can be
 * enforced before a single byte leaves the machine.
 */
export function collectChunks(input: CollectInput, options: FileAccessOptions = {}): FileSelection {
  const root = rootOf(options);
  const skipped = emptySkipped();

  let candidates: string[];
  if (input.glob !== undefined) {
    const expanded = expandGlob(input.glob, { ...options, root });
    candidates = expanded.paths;
    skipped.ignored += expanded.ignored;
    // One count per pruned directory, not one per file inside it.
    skipped.outside_root += expanded.outsideRoot;
  } else {
    candidates = [...(input.paths ?? [])];
  }

  const chunks: FileChunk[] = [];
  let scanned = 0;
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const resolution = resolveInsideRoot(root, candidate);
    if (resolution.kind === "sensitive") {
      skipped.sensitive += 1;
      continue;
    }
    if (resolution.kind === "outside_root") {
      skipped.outside_root += 1;
      continue;
    }
    if (resolution.kind === "not_found") {
      skipped.not_found += 1;
      continue;
    }
    // A glob cannot produce duplicates, but `paths` and symlinks can.
    if (seen.has(resolution.absolute)) continue;
    seen.add(resolution.absolute);

    if (input.glob === undefined && isIgnoredFile(resolution.relative.split("/").pop() ?? "")) {
      skipped.ignored += 1;
      continue;
    }

    const read = readTextFile(resolution.absolute, options.maxFileBytes ?? MAX_FILE_BYTES);
    if (read.kind === "binary") {
      skipped.binary += 1;
      continue;
    }
    if (read.kind === "too_large") {
      skipped.too_large += 1;
      continue;
    }
    if (read.kind === "not_found") {
      skipped.not_found += 1;
      continue;
    }

    const fileChunks = chunkText(resolution.relative, read.text, options);
    if (fileChunks.length === 0) continue; // Empty or whitespace-only file.
    scanned += 1;
    chunks.push(...fileChunks);
  }

  const tokens = estimateSelectionTokens(chunks);
  return {
    chunks,
    files_scanned: scanned,
    skipped,
    est_input_tokens: tokens,
    est_cost_usd: estimateCostUsd(tokens),
    root,
  };
}

/**
 * Refuse a selection that costs too much, and refuse an empty one.
 *
 * Called by every tool between collecting and evaluating, which is the only
 * place where "nothing has been sent yet" is still true.
 */
export function enforceSelection(selection: FileSelection, options: FileAccessOptions = {}): void {
  const ceiling = options.maxInputTokens ?? MAX_INPUT_TOKENS;
  if (selection.est_input_tokens > ceiling) {
    throw new FileSelectionError(
      "cost_ceiling",
      `This call would send an estimated ${selection.est_input_tokens.toLocaleString("en-US")} input tokens ` +
        `(about $${selection.est_cost_usd.toFixed(2)}) across ${selection.chunks.length} chunks of ` +
        `${selection.files_scanned} files, over the ${ceiling.toLocaleString("en-US")}-token ceiling for one call. ` +
        `Nothing was sent. Narrow the glob, pass fewer paths, or use \`unit: "file"\` on a smaller set.`,
    );
  }
  if (selection.chunks.length === 0) {
    const detail = skippedTotal(selection.skipped) === 0 ? "" : ` Skipped: ${JSON.stringify(selection.skipped)}.`;
    throw new FileSelectionError(
      "nothing_readable",
      `No readable text was found in the files named.${detail} ` +
        `Sensitive files, binaries, files over ${Math.round((options.maxFileBytes ?? MAX_FILE_BYTES) / 1024)} KB ` +
        `and generated output are never read.`,
    );
  }
}
