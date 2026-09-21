/**
 * The cheap half of the semantic code lint: a regex gate that decides whether
 * the model is asked at all, and which questions.
 *
 * The pairing is the whole point (sde_cascade). A regex decides *presence* —
 * whether a `catch`, an `any`, a secret-shaped literal, a removed `expect` is
 * anywhere in the change — because Jev cannot reliably find or count a token in
 * a 6k-char diff. The Noul that follows decides *meaning* — whether the `catch`
 * discards the error, whether the `any` is a new escape hatch or just the word
 * in a comment. So most edits match no gate and cost nothing; only the ones
 * that do are judged, and only on the questions their gates fired.
 */

export const LINT_QUESTION_IDS = [
  "removes_test",
  "swallows_exception",
  "hardcodes_secret",
  "hardcodes_url_or_path",
  "adds_suppression",
  "changes_public_signature",
  "leaves_placeholder",
] as const;
export type LintQuestionId = (typeof LINT_QUESTION_IDS)[number];

export interface LintEditInput {
  tool: string;
  file_path: string;
  /** The prior content: an Edit's `old_string`, or a Write's existing file. */
  old?: string | undefined;
  /** The new content: an Edit's `new_string`, or a Write's `content`. */
  new: string;
  /** MultiEdit: each edit's before/after, flattened by the caller. */
  edits?: { old_string: string; new_string: string }[] | undefined;
}

export type LintPrefilterVerdict =
  | { kind: "skip"; reason: "whitespace-only" | "pure-rename" | "non-code-file" | "empty" | "too-large" | "no-gate" }
  | {
      kind: "judge";
      language: string;
      removed: string[];
      added: string[];
      ask: LintQuestionId[];
      reason: string;
    };

/** Longest change lint will judge in one request. */
const MAX_LINT_CHARS = 40_000;

const NON_CODE = new Set([
  "md",
  "mdx",
  "txt",
  "rst",
  "adoc",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "pdf",
  "lock",
  "map",
  "csv",
  "tsv",
]);

/** Config formats: only secret / URL-path gates apply, never test or signature ones. */
const CONFIG_EXTENSIONS = new Set(["json", "yaml", "yml", "toml", "ini", "properties", "cfg", "conf"]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shell",
  sql: "sql",
  vue: "vue",
  svelte: "svelte",
};

// ------------------------------------------------------------- the regex gates

const REMOVED_TEST = /\b(test|it|describe|expect|assert\w*|should|toBe|toEqual|@Test|def test_)\b/;
const ADDED_SKIP = /\.skip\(|xit\(|xdescribe\(|@skip|pytest\.mark\.skip/;
const CATCH = /\b(catch|except|rescue)\b/;
const SECRET_KEYED = /\b(api[_-]?key|secret|token|passw(or)?d|private[_-]?key|authorization)\b\s*[:=]/i;
const BEGIN_BLOCK = /-----BEGIN/;
const URL = /https?:\/\//;
const ABS_PATH = /(^|["'\s])\/(Users|home|etc|var|opt|tmp)\//;
const WIN_PATH = /[A-Z]:\\\\/;
const SUPPRESSION =
  /:\s*any\b|as any\b|@ts-ignore|@ts-expect-error|eslint-disable|# type: ignore|# noqa|#pragma warning disable|@SuppressWarnings|nolint/;
const PUBLIC_SIGNATURE =
  /^\s*(export\s+(async\s+)?(function|const|class|interface|type|enum)|public\s+|pub\s+fn|def\s+\w+\(|func\s+[A-Z])/;
const PLACEHOLDER =
  /\b(TODO|FIXME|XXX|HACK|placeholder|not implemented|NotImplemented|unimplemented!)\b|throw new Error\(["'](TODO|not implemented)|^\s*pass\s*$|^\s*\.\.\.\s*$/i;

/** A quoted run that looks like a base64/hex secret, with real entropy behind it. */
const QUOTED = /["'`]([A-Za-z0-9+/_\-]{20,}={0,2})["'`]/g;

/** Shannon entropy in bits per character. A real key is high; "aaaaaaaa" is not. */
export function entropyBitsPerChar(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export function looksLikeSecretLiteral(line: string): boolean {
  if (SECRET_KEYED.test(line) || BEGIN_BLOCK.test(line)) return true;
  for (const match of line.matchAll(QUOTED)) {
    const value = match[1] as string;
    if (entropyBitsPerChar(value) > 3.5) return true;
  }
  return false;
}

function extensionOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Lines added and removed, as a plain set difference (enough for the gates). */
export function lineDiff(old: string, next: string): { removed: string[]; added: string[] } {
  const oldLines = old.split("\n");
  const newLines = next.split("\n");
  const oldSet = new Set(oldLines.map((l) => l.trim()));
  const newSet = new Set(newLines.map((l) => l.trim()));
  const removed = oldLines.filter((l) => l.trim() !== "" && !newSet.has(l.trim()));
  const added = newLines.filter((l) => l.trim() !== "" && !oldSet.has(l.trim()));
  return { removed, added };
}

/** Collapse all whitespace, so a reindent or a reflow reads as no change. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A change that only renames one identifier consistently, everywhere. Tokenise
 * both sides, drop the tokens they share, and if what is left is one token on
 * each side (the old name and the new), and substituting it makes the sides
 * equal, it is a pure rename — nothing for the lint to judge.
 */
function isPureRename(old: string, next: string): boolean {
  if (old === next) return false;
  const oldTokens = old.match(/[A-Za-z_$][\w$]*/g) ?? [];
  const newTokens = next.match(/[A-Za-z_$][\w$]*/g) ?? [];
  if (oldTokens.length !== newTokens.length || oldTokens.length === 0) return false;
  let from: string | undefined;
  let to: string | undefined;
  for (let i = 0; i < oldTokens.length; i += 1) {
    const a = oldTokens[i] as string;
    const b = newTokens[i] as string;
    if (a === b) continue;
    if (from === undefined) {
      from = a;
      to = b;
    } else if (a !== from || b !== to) {
      return false;
    }
  }
  if (from === undefined || to === undefined) return false;
  return normalizeWhitespace(old.split(from).join(to)) === normalizeWhitespace(next);
}

/** Which question gates fire, given the removed and added lines and the file kind. */
function gatesFor(removed: readonly string[], added: readonly string[], configOnly: boolean): LintQuestionId[] {
  const removedText = removed.join("\n");
  const addedText = added.join("\n");
  const ask: LintQuestionId[] = [];
  const push = (id: LintQuestionId): void => {
    if (!ask.includes(id)) ask.push(id);
  };

  if (added.some(looksLikeSecretLiteral)) push("hardcodes_secret");
  if (URL.test(addedText) || ABS_PATH.test(addedText) || WIN_PATH.test(addedText)) push("hardcodes_url_or_path");
  if (configOnly) return ask;

  if (REMOVED_TEST.test(removedText) || ADDED_SKIP.test(addedText)) push("removes_test");
  if (CATCH.test(addedText)) push("swallows_exception");
  if (SUPPRESSION.test(addedText)) push("adds_suppression");
  if (added.some((l) => PUBLIC_SIGNATURE.test(l)) || removed.some((l) => PUBLIC_SIGNATURE.test(l)))
    push("changes_public_signature");
  if (PLACEHOLDER.test(addedText)) push("leaves_placeholder");
  return ask;
}

/**
 * Decide whether this edit is judged, and on which questions.
 *
 * `hasConventions` says whether there are CLAUDE.md convention lines to check;
 * an edit that matches no gate is still judged when there are conventions and
 * the level is advisory, so the caller passes that in and this returns `judge`
 * with an empty `ask` in that case (the conventions are added by the caller).
 */
export function lintPrefilter(input: LintEditInput, hasConventions = false): LintPrefilterVerdict {
  const old = input.old ?? (input.edits ? input.edits.map((e) => e.old_string).join("\n") : "");
  const next = input.edits ? input.edits.map((e) => e.new_string).join("\n") : input.new;

  if (next.trim() === "" && old.trim() === "") return { kind: "skip", reason: "empty" };
  if (old.length + next.length > MAX_LINT_CHARS) return { kind: "skip", reason: "too-large" };

  const ext = extensionOf(input.file_path);
  if (NON_CODE.has(ext)) return { kind: "skip", reason: "non-code-file" };

  const { removed, added } = lineDiff(old, next);
  const configOnly = CONFIG_EXTENSIONS.has(ext) || /(^|\.)env($|\.)/i.test(input.file_path.split("/").pop() ?? "");
  const ask = gatesFor(removed, added, configOnly);

  // A change that trips a gate is judged even if it also looks like a rename or
  // a reflow: widening a type to `any` is one token substituted consistently,
  // but it is a suppression, not a rename. The cheap skips only apply when no
  // gate fired.
  if (ask.length === 0) {
    if (normalizeWhitespace(old) === normalizeWhitespace(next)) return { kind: "skip", reason: "whitespace-only" };
    if (isPureRename(old, next)) return { kind: "skip", reason: "pure-rename" };
    if (!hasConventions) return { kind: "skip", reason: "no-gate" };
  }

  const language = LANGUAGE_BY_EXT[ext] ?? (configOnly ? "config" : ext || "text");
  return {
    kind: "judge",
    language,
    removed,
    added,
    ask,
    reason: ask.length > 0 ? `gates: ${ask.join(", ")}` : "conventions only",
  };
}
