/**
 * Reading a final message's factual claims about the workspace, and checking
 * the cheap ones in code before the model ever runs.
 *
 * A "Done" message that names a file that is not there, or an identifier that
 * the diff never added, is a fabrication a Stop hook can catch deterministically
 * — no model, no false positives from a classifier. That is stage 1 here. Stage
 * 2 (the model reading `git diff HEAD`) is in `verify-core.ts`; this file only
 * extracts the references and applies the block policy over both stages.
 *
 * Everything here is pure: it takes the message text and a small reader
 * interface, so the whole thing is tested over a temp git tree with planted
 * false claims, with no daemon and no network.
 */

import type { ClaimResult } from "../tools/verify-core.js";

export interface FileRef {
  path: string;
  line?: number | undefined;
  end_line?: number | undefined;
  sentence: string;
  /** The sentence says this file was removed. */
  removal: boolean;
}

export interface IdentRef {
  name: string;
  /** A file named in the same sentence, if any. */
  file?: string | undefined;
  sentence: string;
}

export interface ChangeClaim {
  text: string;
  files: string[];
  idents: string[];
}

export interface ExtractLimits {
  files: number;
  idents: number;
  claims: number;
}

export const CLAIM_LIMITS: ExtractLimits = { files: 40, idents: 40, claims: 20 };

const FILE_EXTENSIONS =
  "tsx?|mjs|cjs|jsx?|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|md|json|ya?ml|toml|css|scss|html|vue|svelte|sql|graphql|proto";
const FILE_REF = new RegExp(
  `(?<![\\w@/.-])((?:[\\w.-]+/)*[\\w-]+\\.(?:${FILE_EXTENSIONS}))(?::(\\d+)(?:-(\\d+))?)?(?![\\w/])`,
  "g",
);
const REMOVAL = /\b(removed|deleted|dropped|no longer exists|no longer present)\b/i;
const IDENT_REF = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\(\))?`/g;
const CHANGE_VERB =
  /\b(added|removed|deleted|renamed|created|updated|changed|replaced|moved|extracted|introduced|implemented|fixed|wrote|refactored|wired|exported)\b/i;

/** Words that look like identifiers but name nothing in the code. */
const IDENT_STOPLIST = new Set([
  "npm",
  "git",
  "node",
  "true",
  "false",
  "null",
  "main",
  "test",
  "build",
  "json",
  "html",
  "todo",
]);

/** Split a message into sentences, stripping markdown bullets and code fences. */
function sentences(message: string): string[] {
  const withoutFences = message.replace(/```[\s\S]*?```/g, " ");
  const out: string[] = [];
  for (const raw of withoutFences.split(/(?<=[.!?])\s+|\n+/)) {
    const trimmed = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
    if (trimmed !== "") out.push(trimmed.slice(0, 240));
  }
  return out;
}

/** Is a backticked identifier substantial enough to be a real symbol? */
function looksLikeIdentifier(name: string): boolean {
  if (name.length < 4) return false;
  if (IDENT_STOPLIST.has(name.toLowerCase())) return false;
  return /[a-z][A-Z]/.test(name) || name.includes("_") || name.includes(".") || name.length >= 8;
}

/** Does this file reference look like a project path (not a URL or a home path)? */
export function isProjectRelative(path: string): boolean {
  if (path.startsWith("~") || path.startsWith("/")) return false;
  if (/^[a-z]+:\/\//i.test(path)) return false;
  return true;
}

export function extractClaims(message: string, limits: ExtractLimits = CLAIM_LIMITS): {
  files: FileRef[];
  idents: IdentRef[];
  claims: ChangeClaim[];
} {
  const files: FileRef[] = [];
  const idents: IdentRef[] = [];
  const claims: ChangeClaim[] = [];

  for (const sentence of sentences(message)) {
    const removal = REMOVAL.test(sentence);
    const sentenceFiles: string[] = [];
    for (const match of sentence.matchAll(FILE_REF)) {
      const path = match[1] as string;
      const ref: FileRef = { path, sentence, removal };
      if (match[2] !== undefined) ref.line = Number(match[2]);
      if (match[3] !== undefined) ref.end_line = Number(match[3]);
      sentenceFiles.push(path);
      if (files.length < limits.files) files.push(ref);
    }

    const sentenceIdents: string[] = [];
    for (const match of sentence.matchAll(IDENT_REF)) {
      const name = match[1] as string;
      if (!looksLikeIdentifier(name)) continue;
      // A file named in the same sentence, else the only file in the whole
      // message (resolved by the caller), else unassociated.
      const ref: IdentRef = { name, sentence };
      if (sentenceFiles[0] !== undefined) ref.file = sentenceFiles[0];
      sentenceIdents.push(name);
      if (idents.length < limits.idents) idents.push(ref);
    }

    if (CHANGE_VERB.test(sentence) && (sentenceFiles.length > 0 || sentenceIdents.length > 0)) {
      if (claims.length < limits.claims) claims.push({ text: sentence, files: sentenceFiles, idents: sentenceIdents });
    }
  }

  // An identifier with no file of its own borrows the message's only file.
  const onlyFile = files.length > 0 && new Set(files.map((f) => f.path)).size === 1 ? files[0]!.path : undefined;
  if (onlyFile !== undefined) {
    for (const ident of idents) if (ident.file === undefined) ident.file = onlyFile;
  }

  return { files, idents, claims };
}

// ------------------------------------------------------------------- stage 1

export type Stage1Verdict = "present" | "fabricated" | "removed-ok" | "unlocated" | "refused" | "stale-line";

export interface Stage1Context {
  fileExists: (rel: string) => "yes" | "no" | "refused";
  readFile: (rel: string) => { kind: "text"; text: string } | { kind: string };
  nameStatus: Map<string, "A" | "M" | "D" | "R">;
  /** `git diff HEAD` text, for identifier presence on `+` lines. */
  diffText: string;
}

export interface CheckedFile extends FileRef {
  verdict: Stage1Verdict;
}

export interface CheckedIdent extends IdentRef {
  verdict: Stage1Verdict;
}

/** The `+` lines of a diff joined into one string, for a cheap `includes` check. */
function addedLines(diffText: string): string {
  return diffText
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
}

/**
 * The deterministic pass: which references the workspace flatly contradicts.
 *
 * A `fabricated` verdict is a fact, not a probability — the file is not there,
 * or the identifier is in neither the file nor the diff — so it blocks without a
 * model. Everything softer (`unlocated`, `stale-line`) is logged and never
 * blocks. Refused paths (sensitive, outside the cwd) are not counted at all.
 */
export function checkReferences(
  extracted: { files: readonly FileRef[]; idents: readonly IdentRef[] },
  ctx: Stage1Context,
): { files: CheckedFile[]; idents: CheckedIdent[] } {
  const added = addedLines(ctx.diffText);

  const files = extracted.files.map((ref): CheckedFile => {
    if (!isProjectRelative(ref.path)) return { ...ref, verdict: "unlocated" };
    const exists = ctx.fileExists(ref.path);
    if (exists === "refused") return { ...ref, verdict: "refused" };
    const status = ctx.nameStatus.get(ref.path);
    if (ref.removal) {
      // Says it removed a file. Fine if the diff deletes it or it is gone.
      if (status === "D" || exists === "no") return { ...ref, verdict: "removed-ok" };
      return { ...ref, verdict: "fabricated" };
    }
    // A non-removal reference to a file that is not there and not being deleted.
    if (exists === "no" && status !== "D") return { ...ref, verdict: "fabricated" };
    if (ref.line !== undefined) {
      const read = ctx.readFile(ref.path);
      if (read.kind === "text") {
        const lineCount = (read as { text: string }).text.split("\n").length;
        if (ref.line > lineCount) return { ...ref, verdict: "stale-line" };
      }
    }
    return { ...ref, verdict: "present" };
  });

  const idents = extracted.idents.map((ref): CheckedIdent => {
    if (ref.file === undefined) return { ...ref, verdict: "unlocated" };
    if (!isProjectRelative(ref.file)) return { ...ref, verdict: "unlocated" };
    const segment = ref.name.split(".").pop() ?? ref.name;
    const read = ctx.readFile(ref.file);
    const inFile = read.kind === "text" && (read as { text: string }).text.includes(segment);
    const inDiff = added.includes(segment);
    if (read.kind === "refused") return { ...ref, verdict: "refused" };
    return inFile || inDiff ? { ...ref, verdict: "present" } : { ...ref, verdict: "fabricated" };
  });

  return { files, idents };
}

// -------------------------------------------------------------------- policy

export interface ClaimItem {
  claim: string;
  verdict: string;
  p?: number | undefined;
}

export interface ClaimCounts {
  extracted: number;
  fabricated: number;
  contradicted: number;
  supported: number;
  not_addressed: number;
  unlocated: number;
}

export interface StopClaimsResult {
  block: boolean;
  items: ClaimItem[];
  counts: ClaimCounts;
}

/**
 * Block iff the workspace flatly contradicts the message: at least one
 * `fabricated` reference (stage 1, code), or at least one claim the model read
 * as `contradicted` with p >= auto (stage 2). Everything else — `not_addressed`,
 * `supported`, `conflicting`, `unlocated` — is logged, never blocked, because a
 * diff shows changes and not the resulting state.
 */
export function stopClaimsPolicy(
  stage1: { files: readonly CheckedFile[]; idents: readonly CheckedIdent[] },
  verified: readonly ClaimResult[] | undefined,
  auto: number,
): StopClaimsResult {
  const items: ClaimItem[] = [];

  const fabricatedFiles = stage1.files.filter((f) => f.verdict === "fabricated");
  const fabricatedIdents = stage1.idents.filter((i) => i.verdict === "fabricated");
  for (const f of fabricatedFiles) items.push({ claim: `\`${f.path}\` is not in the project`, verdict: "fabricated" });
  for (const i of fabricatedIdents) {
    items.push({
      claim: `\`${i.name}\` is not in ${i.file ?? "the changed code"}`,
      verdict: "fabricated",
    });
  }

  let contradicted = 0;
  let supported = 0;
  let notAddressed = 0;
  for (const claim of verified ?? []) {
    if (claim.verdict === "supported") supported += 1;
    else if (claim.verdict === "not_addressed") notAddressed += 1;
    else if (claim.verdict === "contradicted") {
      const p = claim.probabilities.contradicted ?? 0;
      contradicted += 1;
      if (p >= auto) items.push({ claim: `"${claim.claim}" is contradicted by the diff`, verdict: "contradicted", p });
    }
  }

  const counts: ClaimCounts = {
    extracted: stage1.files.length + stage1.idents.length,
    fabricated: fabricatedFiles.length + fabricatedIdents.length,
    contradicted,
    supported,
    not_addressed: notAddressed,
    unlocated: stage1.files.filter((f) => f.verdict === "unlocated").length + stage1.idents.filter((i) => i.verdict === "unlocated").length,
  };

  return { block: items.length > 0, items, counts };
}
