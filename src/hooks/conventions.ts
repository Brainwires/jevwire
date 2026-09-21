/**
 * The project's own coding rules, pulled from CLAUDE.md, for the lint to check
 * an edit against.
 *
 * Only lines that read as a *rule about code* are kept: a bullet or numbered
 * line with a rule word (always/never/must/avoid/prefer…) and a code word (or a
 * backtick). Prose, goals, and section headers are dropped, because a Noul
 * asked "does this edit go against <a paragraph of background>" answers noise.
 * Nothing else from CLAUDE.md is ever sent to the model.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { readProjectFile } from "./workspace.js";

/** Most convention lines sent with one edit. */
export const MAX_CONVENTIONS = 12;
/** Longest a single convention line may be. */
const MAX_CONVENTION_CHARS = 240;

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const RULE_SIGNAL = /\b(always|never|must|should|do not|don't|avoid|prefer|use|only|no)\b/i;
const CODE_SIGNAL =
  /\b(import|export|test|type|function|class|file|module|lint|format|commit|log|error|async|await)\b/;
const SECTION_HEADING = /^#{1,3}\s*(conventions?|code style|coding|style|rules|guidelines)/i;

/** Strip markdown emphasis/inline-code markers, leaving the words and backtick spans intact enough to test. */
function stripMarkdown(line: string): string {
  return line
    .replace(BULLET, "")
    .replace(/\*\*|__/g, "")
    .replace(/^\s+|\s+$/g, "");
}

/**
 * The rule lines of a CLAUDE.md, with the ones under a conventions/style/rules
 * heading first. Pure.
 */
export function extractConventions(text: string, max = MAX_CONVENTIONS): string[] {
  const lines = text.split("\n");
  const underHeading: string[] = [];
  const rest: string[] = [];
  let inSection = false;

  for (const raw of lines) {
    if (/^#{1,6}\s+/.test(raw)) {
      inSection = SECTION_HEADING.test(raw);
      continue;
    }
    if (!BULLET.test(raw)) continue;
    const line = stripMarkdown(raw);
    if (line.length === 0 || line.length > MAX_CONVENTION_CHARS) continue;
    const hasCode = line.includes("`") || CODE_SIGNAL.test(line);
    if (!RULE_SIGNAL.test(line) || !hasCode) continue;
    (inSection ? underHeading : rest).push(line);
  }

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const line of [...underHeading, ...rest]) {
    if (seen.has(line)) continue;
    seen.add(line);
    ordered.push(line);
    if (ordered.length >= max) break;
  }
  return ordered;
}

interface CacheEntry {
  mtimeKey: string;
  conventions: string[];
}

const cache = new Map<string, CacheEntry>();

/** The mtimes of the two CLAUDE.md paths, as one string; missing files count as 0. */
function mtimeKey(cwd: string): { key: string; paths: string[] } {
  const paths = [join(cwd, "CLAUDE.md"), join(cwd, ".claude", "CLAUDE.md")];
  const key = paths
    .map((path) => {
      try {
        return String(statSync(path).mtimeMs);
      } catch {
        return "0";
      }
    })
    .join(":");
  return { key, paths };
}

/**
 * The project's conventions for `cwd`, cached until a CLAUDE.md changes.
 *
 * Reads both `CLAUDE.md` and `.claude/CLAUDE.md` (project root wins order),
 * through the hook-safe reader so the same refusals apply. Cheap enough to call
 * per edit: it re-`stat`s two files and returns the cached list unless one moved.
 */
export function readProjectConventions(cwd: string): string[] {
  const { key, paths } = mtimeKey(cwd);
  const cached = cache.get(cwd);
  if (cached !== undefined && cached.mtimeKey === key) return cached.conventions;

  const merged: string[] = [];
  for (const path of paths) {
    const rel = path.slice(cwd.length + 1);
    const read = readProjectFile(cwd, rel);
    if (read.kind === "text") merged.push(...extractConventions(read.text, MAX_CONVENTIONS));
  }
  const seen = new Set<string>();
  const conventions = merged.filter((line) => (seen.has(line) ? false : (seen.add(line), true))).slice(0, MAX_CONVENTIONS);

  cache.set(cwd, { mtimeKey: key, conventions });
  return conventions;
}

/** Clear the cache — for tests, and after a daemon restart. */
export function clearConventionsCache(): void {
  cache.clear();
}
