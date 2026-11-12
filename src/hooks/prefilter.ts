/**
 * Deterministic prefilters: decide in code whether Jev is called at all.
 *
 * Three jobs, in order of confidence:
 *  1. Recognize the small set of commands that are unambiguously catastrophic
 *     and escalate them without asking a model. A regex is more reliable than
 *     a classifier for `rm -rf ~`.
 *  2. Recognize work that is plainly read-only, and stay out of the way. This
 *     is what keeps the hook from costing a call and 300 ms on every `ls`.
 *  3. Send everything else to judgment. "Everything else" includes anything
 *     the tokenizer did not fully understand: an unknown construct is a reason
 *     to look closer, never a reason to skip.
 *
 * Pure functions only. No I/O, no clock, no model.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GateAction } from "../tools/gate-action-core.js";
import type { Json } from "../decision/types.js";
import { isSensitivePath } from "../util/sensitive-path.js";
import { isSidecarBody, parseMarker, type AffirmationMarker } from "./tripwire.js";

/**
 * Re-exported so that `src/hooks/*` and its tests keep one import site for the
 * predicate. The definition lives in `src/util/sensitive-path.ts` because the
 * MCP file layer needs the identical answer and must not import a hook module.
 */
export { isSensitivePath };

/** Fields every verdict may carry. */
interface PrefilterCommon {
  reason: string;
  /** An affirmation marker found on the action, honoured or not. */
  marker?: AffirmationMarker;
  /**
   * The tool input with the marker text removed. Present only when a marker was
   * stripped, and then it is what everything downstream must use: the
   * fingerprint, the action sent to Jev, and the verification ledger all have to
   * see the same command the tokenizer classified.
   */
  stripped?: Record<string, unknown>;
}

export type Prefilter =
  /** Plainly read-only, or an ordinary in-project edit: no Jev call, no output. */
  | ({ kind: "skip"; writesInProject?: boolean } & PrefilterCommon)
  /** Send to Jev. */
  | ({ kind: "judge"; writesInProject?: boolean } & PrefilterCommon)
  /** Code is sure enough to trip on its own. */
  | ({ kind: "escalate"; pattern: string } & PrefilterCommon)
  /**
   * A do-nothing Bash call carrying an affirmation marker: `true # jev:intended
   * t-1a2b3c4d: <reason>`. The sidecar form, which is how a Write, an Edit or an
   * MCP call — none of which has a comment syntax — answers a tripwire.
   */
  | ({ kind: "affirm" } & PrefilterCommon);

// --------------------------------------------------------------- bash scanner

export interface BashFeatures {
  /** `>`, `>>`, `&>`, `>|`, `>(`. Input redirects are read-only and ignored. */
  redirect: boolean;
  /** `$(...)`, backticks, `<(...)`: we cannot see what actually runs. */
  substitution: boolean;
  /** `$VAR`, `${VAR}`: we cannot see what the word expands to. */
  expansion: boolean;
  /** Subshells and brace groups: structure this scanner does not model. */
  grouping: boolean;
  /** `<<` / `<<<`: the body is inline content this scanner does not model. */
  heredoc: boolean;
  /** A quote never closed. */
  unbalanced: boolean;
}

/**
 * One output redirect, with the word it points at.
 *
 * Kept separately from the token list because a redirect target is not an
 * argument: `echo x > f` runs `echo x` and writes `f`, and deciding whether
 * that is an ordinary edit means knowing which of the two `f` is.
 */
export interface Redirect {
  /** `>`, `>>`, `&>`, or `>&` for a file-descriptor duplication. */
  op: string;
  /** The word that followed, empty when nothing did. */
  target: string;
  /** Index into `segments` of the command whose output is redirected. */
  segment: number;
  /**
   * Not a write to a file in the project: `2>&1`, `>/dev/null`. These cannot
   * escape anywhere, so they are not treated as writes at all.
   */
  special: boolean;
}

/** A here-document: input *data* for a command, not more command text. */
export interface Heredoc {
  delimiter: string;
  /** `<<'EOF'` and `<<"EOF"` suppress expansion inside the body. */
  quoted: boolean;
  body: string;
  segment: number;
}

export interface BashScan {
  /** One token list per pipeline/`&&`/`;` segment, empty ones dropped. */
  segments: string[][];
  features: BashFeatures;
  /** Output redirects, in source order. */
  redirects: Redirect[];
  /** Here-documents whose bodies were consumed as data. */
  heredocs: Heredoc[];
}

/** Writing here is not writing a file. */
const NULL_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"]);

const SEPARATORS = new Set([";", "\n", "|", "&"]);

/**
 * Tokenize a shell command far enough to reason about it, and flag every
 * construct that makes the reasoning unsound.
 *
 * This is not a shell parser and does not try to be. It is quote-aware,
 * separator-aware, and loudly pessimistic about anything else.
 */
export function scanBash(command: string): BashScan {
  const features: BashFeatures = {
    redirect: false,
    substitution: false,
    expansion: false,
    grouping: false,
    heredoc: false,
    unbalanced: false,
  };
  const segments: string[][] = [];
  const redirects: Redirect[] = [];
  const heredocs: Heredoc[] = [];
  let tokens: string[] = [];
  let token = "";
  let started = false;
  /** Set by `>`; the next completed token is its target. */
  let pendingRedirect: Redirect | undefined;

  const endToken = (): void => {
    if (started) {
      tokens.push(token);
      if (pendingRedirect !== undefined) {
        pendingRedirect.target = token;
        pendingRedirect.special = NULL_SINKS.has(token);
        pendingRedirect = undefined;
      }
      token = "";
      started = false;
    }
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  const push = (text: string): void => {
    token += text;
    started = true;
  };

  interface PendingHeredoc {
    delimiter: string;
    quoted: boolean;
    dashed: boolean;
    segment: number;
  }
  let pendingHeredocs: PendingHeredoc[] = [];

  /**
   * Swallow the bodies of every here-document opened on the line just ended.
   *
   * An unquoted delimiter means the shell expands the body, so a `$(…)` in
   * there is executed; that sets the same feature flag an inline substitution
   * would, and the command is judged rather than skipped.
   */
  const consumeHeredocBodies = (): void => {
    for (const pending of pendingHeredocs) {
      const lines: string[] = [];
      for (;;) {
        const newline = command.indexOf("\n", index);
        const line = newline === -1 ? command.slice(index) : command.slice(index, newline);
        index = newline === -1 ? command.length : newline + 1;
        if ((pending.dashed ? line.replace(/^\t+/, "") : line) === pending.delimiter) break;
        lines.push(line);
        if (newline === -1) {
          features.unbalanced = true; // Unterminated here-document.
          break;
        }
      }
      const body = lines.join("\n");
      if (!pending.quoted) {
        if (/\$\(|`/.test(body)) features.substitution = true;
        else if (/\$/.test(body)) features.expansion = true;
      }
      heredocs.push({ delimiter: pending.delimiter, quoted: pending.quoted, body, segment: pending.segment });
    }
    pendingHeredocs = [];
  };

  let index = 0;
  while (index < command.length) {
    const char = command[index] as string;

    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) {
        features.unbalanced = true;
        push(command.slice(index + 1));
        index = command.length;
        continue;
      }
      push(command.slice(index + 1, close));
      index = close + 1;
      continue;
    }

    if (char === '"') {
      index += 1;
      let closed = false;
      while (index < command.length) {
        const inner = command[index] as string;
        if (inner === "\\") {
          push(command[index + 1] ?? "");
          index += 2;
          continue;
        }
        if (inner === '"') {
          closed = true;
          index += 1;
          break;
        }
        if (inner === "`") {
          features.substitution = true;
          index += 1;
          continue;
        }
        if (inner === "$") {
          if (command[index + 1] === "(") features.substitution = true;
          else features.expansion = true;
          push(inner);
          index += 1;
          continue;
        }
        push(inner);
        index += 1;
      }
      if (!closed) features.unbalanced = true;
      started = true;
      continue;
    }

    if (char === "\\") {
      push(command[index + 1] ?? "");
      index += 2;
      continue;
    }

    if (char === "`") {
      features.substitution = true;
      index += 1;
      continue;
    }

    if (char === "$") {
      if (command[index + 1] === "(") {
        features.substitution = true;
        index += 2;
        continue;
      }
      if (command[index + 1] === "{") {
        // `${HOME}/x` is one word. Without this the braces read as a group
        // and the word fell apart into `$`, `HOME`, `/x`.
        const close = command.indexOf("}", index + 2);
        if (close !== -1) {
          features.expansion = true;
          push(command.slice(index, close + 1));
          index = close + 1;
          continue;
        }
      }
      features.expansion = true;
      push(char);
      index += 1;
      continue;
    }

    if (char === ">") {
      features.redirect = true;
      endToken();
      let op = ">";
      index += 1;
      if (command[index] === ">") {
        op = ">>";
        index += 1;
      } else if (command[index] === "|") {
        index += 1;
      }
      if (command[index] === "(") {
        features.substitution = true;
        index += 1;
        continue;
      }
      if (command[index] === "&") {
        // `2>&1`, `>&2`: duplicating a file descriptor writes no file.
        index += 1;
        let fd = "";
        while (index < command.length && /[0-9-]/.test(command[index] as string)) {
          fd += command[index];
          index += 1;
        }
        if (fd !== "") {
          redirects.push({ op: `${op}&`, target: fd, segment: segments.length, special: true });
          continue;
        }
      }
      pendingRedirect = { op, target: "", segment: segments.length, special: false };
      redirects.push(pendingRedirect);
      continue;
    }

    if (char === "<") {
      if (command[index + 1] === "(") features.substitution = true;
      endToken();
      if (command[index + 1] === "<" && command[index + 2] !== "<") {
        // A here-document: the body is data, so it is consumed rather than
        // tokenized as more command text. `<<<` (a here-string) is not.
        features.heredoc = true;
        index += 2;
        let dashed = false;
        if (command[index] === "-") {
          dashed = true;
          index += 1;
        }
        while (command[index] === " " || command[index] === "\t") index += 1;
        let delimiter = "";
        let quoted = false;
        const quote = command[index];
        if (quote === "'" || quote === '"') {
          quoted = true;
          index += 1;
          while (index < command.length && command[index] !== quote) {
            delimiter += command[index];
            index += 1;
          }
          index += 1;
        } else {
          if (command[index] === "\\") {
            quoted = true;
            index += 1;
          }
          while (index < command.length && /[A-Za-z0-9_.-]/.test(command[index] as string)) {
            delimiter += command[index];
            index += 1;
          }
        }
        if (delimiter === "") features.unbalanced = true;
        else pendingHeredocs.push({ delimiter, quoted, dashed, segment: segments.length });
        continue;
      }
      if (command[index + 1] === "<") features.heredoc = true;
      index += 1;
      while (command[index] === "<") index += 1;
      continue;
    }

    if (char === "&") {
      if (command[index + 1] === ">") {
        features.redirect = true;
        endToken();
        index += 2;
        if (command[index] === ">") index += 1;
        pendingRedirect = { op: "&>", target: "", segment: segments.length, special: false };
        redirects.push(pendingRedirect);
        continue;
      }
      endSegment();
      index += command[index + 1] === "&" ? 2 : 1;
      continue;
    }

    if (SEPARATORS.has(char)) {
      endSegment();
      index += char === "|" && command[index + 1] === "|" ? 2 : 1;
      if (char === "\n" && pendingHeredocs.length > 0) consumeHeredocBodies();
      continue;
    }

    if (char === "{" && command[index + 1] === "}") {
      // `{}` is not a group: the shell leaves empty braces alone, and it is
      // the placeholder `xargs -I {}` and `find -exec … {}` take as a word.
      push("{}");
      index += 2;
      continue;
    }

    if (char === "(" || char === ")" || char === "{" || char === "}") {
      // `(subshell)`, `{ group; }`, and function definitions are structure this
      // scanner does not model. Flag and move on; the caller will judge.
      features.grouping = true;
      endToken();
      index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      endToken();
      index += 1;
      continue;
    }

    push(char);
    index += 1;
  }

  endSegment();
  // A here-document opened on the last line, with the body following it.
  if (pendingHeredocs.length > 0) consumeHeredocBodies();
  return { segments, features, redirects, heredocs };
}

// ------------------------------------------------------------- hard patterns

/** Shell-agnostic flattening: quotes removed, one space between tokens. */
function flatten(scan: BashScan): string {
  return scan.segments.map((tokens) => tokens.join(" ")).join(" ; ");
}

function isRoot(target: string): boolean {
  return /^\/+\*?$/.test(target);
}

function escapesUp(target: string): boolean {
  return target.split("/").includes("..");
}

/** `~`, `~user`, `$HOME`, with or without a trailing `/` or `/*`. */
function isHomeish(target: string): boolean {
  return /^(~[A-Za-z0-9._-]*|\$HOME|\$\{HOME\})(\/\*?)?$/.test(target);
}

/** A home directory spelled out: `/Users/<name>`, `/home/<name>`, `/root`. */
function isHomeDir(target: string): boolean {
  return /^\/(?:(?:Users|home)\/[^/]+|root)\/?\*?$/.test(target);
}

/**
 * An absolute path one segment deep: `/usr`, `/etc/`, `/var/*`, `/System`.
 * Deleting any of them recursively takes a system apart, so none is treated
 * as ordinary. `/tmp` is depth one too and is accepted as a false positive:
 * the trip is re-runnable with a marker, and `rm -rf /tmp` is rare enough.
 */
function isTopLevel(target: string): boolean {
  return /^\/[^/*]+\/?\*?$/.test(target);
}

/** A delete operand that reaches far beyond a project. */
function isWideTarget(target: string): boolean {
  return isRoot(target) || isHomeish(target) || isHomeDir(target) || isTopLevel(target) || escapesUp(target);
}

/** Is a chmod mode operand one that makes files world-writable? */
function isWorldWritableMode(mode: string): boolean {
  // Octal: the last digit is "other", and bit 2 is write. 777, 0777, 666,
  // 757, 1777 all set it; 755 and 644 do not.
  if (/^[0-7]{3,4}$/.test(mode)) return /[2367]$/.test(mode);
  // Symbolic, possibly a comma list: a clause granting `w` to `o` or `a`.
  // A clause with no who (`+w`) applies the umask and is left alone.
  return mode.split(",").some((clause) => {
    const match = /^([ugoa]+)([+=])([rwxXst]*)$/.exec(clause);
    return match !== null && /[oa]/.test(match[1] as string) && (match[3] as string).includes("w");
  });
}

const RM_RF_WIDE_REASON = "recursive delete of a home, root, or parent-escaping path";

/** The operands of a recursive `rm`, or `undefined` when this is not one. */
function recursiveRmOperands(tokens: string[]): string[] | undefined {
  if (commandOf(tokens) !== "rm") return undefined;
  const operands: string[] = [];
  let recursive = false;
  for (const token of tokens.slice(indexOfCommand(tokens) + 1)) {
    if (token.startsWith("--")) {
      if (token === "--recursive") recursive = true;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (/[rR]/.test(token.slice(1))) recursive = true;
      continue;
    }
    operands.push(token);
  }
  return recursive ? operands : undefined;
}

/** `rm -rf` of the current directory's contents: wide exactly when the cwd is. */
const HERE = new Set(["*", ".", "./", "./*", ".//*"]);

function rmHere(tokens: string[]): boolean {
  const operands = recursiveRmOperands(tokens);
  return operands !== undefined && operands.some((target) => HERE.has(target));
}

/**
 * `find <wide> … -delete` and `find <wide> … -exec rm …` delete as widely as
 * `rm -rf <wide>` does. The starting points are the operands before the first
 * expression token; `find` with none starts at `.`, which is not wide.
 */
function findWideDelete(tokens: string[]): boolean {
  if (commandOf(tokens) !== "find") return false;
  const args = argsOf(tokens);
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    if (arg === "-H" || arg === "-L" || arg === "-P" || arg.startsWith("-O")) index += 1;
    else if (arg === "-D") index += 2;
    else break;
  }
  const paths: string[] = [];
  while (index < args.length && !/^[-(!]/.test(args[index] as string)) {
    paths.push(args[index] as string);
    index += 1;
  }
  if (!paths.some((path) => isWideTarget(path))) return false;
  const expression = args.slice(index);
  if (expression.includes("-delete")) return true;
  return expression.some(
    (arg, at) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg) && (expression[at + 1] ?? "").split("/").pop() === "rm",
  );
}

/**
 * Where a `cd` segment leaves the shell, as far as the next `rm -rf *` is
 * concerned: `true` for a wide target or a bare `cd` (home), `false` for an
 * ordinary directory and for `cd -`, whose destination this code cannot see.
 */
function cdLandsWide(tokens: string[]): boolean | undefined {
  if (commandOf(tokens) !== "cd") return undefined;
  const operand = argsOf(tokens).find((arg) => !arg.startsWith("-") || arg === "-");
  if (operand === undefined) return true;
  return operand !== "-" && isWideTarget(operand);
}

/** A single catastrophic-command check. */
interface HardPattern {
  name: string;
  reason: string;
  matches: (tokens: string[], flat: string) => boolean;
}

const HARD_PATTERNS: HardPattern[] = [
  {
    name: "rm-rf-wide",
    reason: RM_RF_WIDE_REASON,
    matches: (tokens) => {
      const operands = recursiveRmOperands(tokens);
      return operands !== undefined && operands.some((target) => isWideTarget(target));
    },
  },
  {
    name: "git-force-push-main",
    reason: "force push to a main branch",
    matches: (tokens) => {
      if (commandOf(tokens) !== "git" || !tokens.includes("push")) return false;
      // `+main` and `+HEAD:main` are refspecs with the force bit set, so they
      // need no flag at all. `--force-with-lease` is still a rewrite of the
      // remote branch; the lease only says whose history it overwrites.
      if (tokens.some((t) => /^\+(?:.*[:/])?(main|master)$/.test(t))) return true;
      const forced = tokens.some(
        (t) =>
          t === "--force" ||
          t === "-f" ||
          t === "--force-with-lease" ||
          t.startsWith("--force-with-lease=") ||
          t === "--force-if-includes" ||
          /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t),
      );
      if (!forced) return false;
      return tokens.some((t) => /(^|[:/])(main|master)$/.test(t));
    },
  },
  {
    name: "git-reset-hard",
    reason: "git reset --hard discards uncommitted work",
    matches: (tokens) =>
      commandOf(tokens) === "git" && tokens.includes("reset") && tokens.some((t) => t === "--hard"),
  },
  {
    name: "sql-drop",
    reason: "dropping a SQL table or database",
    matches: (_tokens, flat) => /\bdrop\s+(table|database|schema)\b/i.test(flat),
  },
  {
    name: "mkfs",
    reason: "formatting a filesystem",
    matches: (tokens) => /^mkfs(\.|$)/.test(commandOf(tokens)),
  },
  {
    name: "dd-to-device",
    reason: "dd writing straight to a device",
    matches: (tokens) => commandOf(tokens) === "dd" && tokens.some((t) => /^of=\/dev\//.test(t)),
  },
  {
    name: "chmod-777",
    reason: "recursive world-writable permissions",
    matches: (tokens) => {
      if (commandOf(tokens) !== "chmod") return false;
      // `-R` may sit in a cluster (`-fR`, `-Rv`). Uppercase only: chmod has no
      // `-r` option, and `-r` as an operand means "remove read".
      const recursive = tokens.some((t) => t === "--recursive" || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(t));
      return recursive && argsOf(tokens).some((t) => isWorldWritableMode(t));
    },
  },
  {
    name: "fork-bomb",
    reason: "fork bomb",
    matches: (_tokens, flat) => /:\s*\(\s*\)\s*\{/.test(flat),
  },
];

/**
 * Patterns matched on the raw string, for shapes tokenization destroys. Kept
 * to the two that cannot plausibly appear in innocent text.
 */
const RAW_HARD_PATTERNS: [string, string, RegExp][] = [
  ["fork-bomb", "fork bomb", /:\s*\(\s*\)\s*\{\s*:?\s*\|?/],
  ["dd-to-device", "dd writing straight to a device", /\bdd\b[^;|&]*\bof=["']?\/dev\//],
];

// ------------------------------------------------- wrappers and shell strings

/**
 * A command that runs another command, and what of its own it puts in front.
 *
 * The hard patterns look at the command word, so `sudo rm -rf /` used to read
 * as `sudo` and go to judgment — or, with no key or a timed-out call, through.
 * Each wrapper here is stripped, together with its own options and operands,
 * until what is left is the command it runs; the patterns then see that too.
 *
 * `valueFlags` are the options whose value is the next token, so that
 * `sudo -u root rm` strips to `rm` and never to `root`. An attached value
 * (`-n5`, `-I{}`) is one token and needs no entry. `operand` recognizes the
 * wrapper's own positional, such as `timeout`'s duration or `chrt`'s priority.
 */
interface Wrapper {
  valueFlags: ReadonlySet<string>;
  operand?: (token: string) => boolean;
  /** When this returns true the wrapper is not running anything: `command -v`. */
  lookup?: (args: string[]) => boolean;
}

const NO_FLAGS: ReadonlySet<string> = new Set();
const DURATION = /^\d+(\.\d+)?[smhd]?$/;
const NUMBER = /^-?\d+$/;

const WRAPPERS: Record<string, Wrapper> = {
  sudo: {
    valueFlags: new Set([
      "-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-T", "-U",
      "--user", "--group", "--host", "--prompt", "--close-from", "--chdir", "--role", "--type",
      "--command-timeout", "--other-user",
    ]),
  },
  doas: { valueFlags: new Set(["-u", "-C"]) },
  pkexec: { valueFlags: new Set(["-u", "--user"]) },
  // `env -S 'rm -rf /'` splits its string into a command. Not followed here:
  // the value is skipped like any other, and the whole call is still judged.
  env: { valueFlags: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]) },
  command: { valueFlags: NO_FLAGS, lookup: (args) => args.some((arg) => arg === "-v" || arg === "-V") },
  builtin: { valueFlags: NO_FLAGS },
  exec: { valueFlags: new Set(["-a"]) },
  nice: { valueFlags: new Set(["-n", "--adjustment"]) },
  nohup: { valueFlags: NO_FLAGS },
  time: { valueFlags: new Set(["-f", "-o", "--format", "--output"]) },
  timeout: {
    valueFlags: new Set(["-k", "-s", "--kill-after", "--signal"]),
    operand: (token) => DURATION.test(token),
  },
  stdbuf: { valueFlags: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]) },
  ionice: { valueFlags: new Set(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"]) },
  chrt: {
    valueFlags: new Set(["-p", "-T", "-P", "-D", "--pid", "--sched-runtime", "--sched-period", "--sched-deadline"]),
    operand: (token) => NUMBER.test(token),
  },
  // What follows `xargs` is the command with its operands still to come from
  // stdin, so `xargs rm -rf` alone names no target. See `hardPatternHit` for
  // the one shape where the operands are known.
  xargs: {
    valueFlags: new Set([
      "-I", "-i", "-n", "-L", "-l", "-s", "-P", "-a", "-d", "-E",
      "--replace", "--max-args", "--max-lines", "--max-chars", "--max-procs", "--arg-file", "--delimiter", "--eof",
    ]),
  },
  busybox: { valueFlags: NO_FLAGS },
  toybox: { valueFlags: NO_FLAGS },
};

/** Index of the first token after a wrapper's options, honouring `--`. */
function afterOptions(args: string[], valueFlags: ReadonlySet<string>): number {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    if (arg === "--") return index + 1;
    if (!arg.startsWith("-") || arg === "-") return index;
    index += valueFlags.has(arg) ? 2 : 1;
  }
  return index;
}

/**
 * One layer of wrapper removed, or `undefined` when the command is not a
 * wrapper or wraps nothing. The result is always shorter than the input, so
 * repeating this terminates without a counter.
 *
 * Leading `VAR=value` operands (`sudo FOO=x rm`, `env FOO=x rm`) are left in
 * place: `commandOf` already looks past them, exactly as it does for a bare
 * `FOO=x rm`.
 */
function unwrapOnce(tokens: string[]): string[] | undefined {
  const wrapper = WRAPPERS[commandOf(tokens)];
  if (wrapper === undefined) return undefined;
  const args = argsOf(tokens);
  if (wrapper.lookup?.(args) === true) return undefined;
  let index = afterOptions(args, wrapper.valueFlags);
  if (wrapper.operand !== undefined && index < args.length && wrapper.operand(args[index] as string)) index += 1;
  const rest = args.slice(index);
  return rest.length === 0 ? undefined : rest;
}

/**
 * The segment as written, then with each wrapper layer peeled off.
 *
 * `fed` is what an earlier `echo`/`printf` in the command put on stdout. It
 * matters only for `xargs`, whose command gets its operands from stdin: the
 * wide-looking ones are appended so `echo ~ | xargs rm -rf` reads as
 * `rm -rf ~`. The scanner does not tell `|` from `;`, so "earlier" means any
 * earlier segment — which can only add an escalation, never remove one.
 */
function effectiveForms(tokens: string[], fed: readonly string[]): string[][] {
  const forms = [tokens];
  let current = tokens;
  for (;;) {
    const viaXargs = commandOf(current) === "xargs";
    const inner = unwrapOnce(current);
    if (inner === undefined) return forms;
    current = viaXargs && fed.length > 0 ? [...inner, ...fed] : inner;
    forms.push(current);
  }
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

/**
 * The command string a `sh -c …` or an `eval …` would run, if this is one.
 *
 * `-c` may sit in a cluster (`-lc`, `-ec`); the string is the first operand
 * after it. `eval` runs its arguments joined, which is also what the shell
 * does with them.
 */
function shellString(tokens: string[]): string | undefined {
  const name = commandOf(tokens);
  const args = argsOf(tokens);
  if (name === "eval") return args.length === 0 ? undefined : args.join(" ");
  if (!SHELLS.has(name)) return undefined;
  const flag = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
  if (flag === -1) return undefined;
  return args.slice(flag + 1).find((arg) => !arg.startsWith("-"));
}

/**
 * How many levels of nested code the rules open: `sh -c "sh -c …"`, `$( $( … ) )`
 * and every mix of them. Past this the command trips `nesting-too-deep` rather
 * than being let through unread; the limit bounds the work, not the coverage.
 */
const MAX_NESTING = 8;
const NESTING_TOO_DEEP = {
  name: "nesting-too-deep",
  reason: "code nested more deeply than the code rules follow (substitutions or shell strings)",
};

/** Index of the backtick closing one opened just before `start`, or the end. */
function closingBacktick(text: string, start: number): number {
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === "`") return i;
  }
  return text.length;
}

/** Index of the `"` closing a double-quoted string opened just before `start`. */
function closingDoubleQuote(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") i += 2;
    else if (c === '"') return i;
    else if (c === "$" && text[i + 1] === "(") i = closingParen(text, i + 2) + 1;
    else if (c === "`") i = closingBacktick(text, i + 1) + 1;
    else i += 1;
  }
  return text.length;
}

/**
 * Index of the `)` closing a substitution whose body starts at `start`, or the
 * end of the text when there is none — an unclosed body is read to the end,
 * which can only add to what is checked.
 */
function closingParen(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) return text.length;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      i = closingDoubleQuote(text, i + 1) + 1;
      continue;
    }
    if (c === "`") {
      i = closingBacktick(text, i + 1) + 1;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")" && --depth === 0) return i;
    i += 1;
  }
  return text.length;
}

/**
 * The code inside every substitution the shell would run while expanding
 * `text`: `$( … )`, backticks, `<( … )`, `>( … )`, and `$(( … ))` (whose
 * body is read as code too, so a substitution inside it is found on the next
 * level). Only the outermost ones are returned; the caller recurses.
 *
 * Single-quoted text is literal and skipped. Inside double quotes `$( … )`
 * and backticks still run, process substitution does not. `heredoc` reads
 * `text` as the body of an unquoted here-document, where quotes are literal
 * and only `$`, backticks and backslashes mean anything.
 */
export function substitutionBodies(text: string, heredoc = false): string[] {
  const bodies: string[] = [];
  let inDouble = false;
  /** Here-documents opened on the current line, bodies still to come. */
  let pending: { delimiter: string; quoted: boolean; dashed: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (!heredoc && !inDouble && c === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      const open = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/.exec(text.slice(i));
      if (open !== null) {
        const delimiter = open[2] ?? open[3] ?? open[4] ?? "";
        const quoted = open[2] !== undefined || open[3] !== undefined || open[0].includes("\\");
        pending.push({ delimiter, quoted, dashed: open[1] === "-" });
        i += open[0].length;
        continue;
      }
    }
    if (!heredoc && !inDouble && c === "\n" && pending.length > 0) {
      // The bodies follow this line: data, unless the delimiter was unquoted,
      // in which case the shell expands them and their substitutions run.
      i += 1;
      for (const doc of pending) {
        const lines: string[] = [];
        while (i < text.length) {
          const newline = text.indexOf("\n", i);
          const line = newline === -1 ? text.slice(i) : text.slice(i, newline);
          i = newline === -1 ? text.length : newline + 1;
          if ((doc.dashed ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
          lines.push(line);
        }
        if (!doc.quoted) bodies.push(...substitutionBodies(lines.join("\n"), true));
      }
      pending = [];
      continue;
    }
    if (!heredoc && !inDouble && c === "'") {
      const close = text.indexOf("'", i + 1);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    if (!heredoc && c === '"') {
      inDouble = !inDouble;
      i += 1;
      continue;
    }
    if (c === "`") {
      const end = closingBacktick(text, i + 1);
      bodies.push(text.slice(i + 1, end).replace(/\\([\\`$])/g, "$1"));
      i = end + 1;
      continue;
    }
    const opensProcess = !heredoc && !inDouble && (c === "<" || c === ">");
    if ((c === "$" || opensProcess) && text[i + 1] === "(") {
      const end = closingParen(text, i + 2);
      bodies.push(text.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return bodies;
}

const isFlag = (arg: string): boolean => arg.startsWith("-") || arg.startsWith("+");

/** A shell not given a `-c` string: it runs a script file, or stdin. */
function shellWithoutString(form: string[]): boolean {
  return SHELLS.has(commandOf(form)) && !argsOf(form).some((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
}

/** Does a shell with these arguments read its script from stdin? */
function shellReadsStdin(form: string[]): boolean {
  if (!shellWithoutString(form)) return false;
  const args = argsOf(form);
  return args.every(isFlag) || args.includes("-s");
}

/**
 * Code this command runs that its own segments do not show: the bodies of its
 * substitutions (in the command line and in unquoted here-documents), and a
 * script handed to a shell on stdin — a here-document, a here-string, or the
 * output of an `echo`/`printf` before it. The scanner does not tell `|` from
 * `;`, so "before it" means any earlier segment, which can only add a check.
 */
function hiddenCode(command: string, scan: BashScan): string[] {
  const code = substitutionBodies(command);
  const hereStrings = scan.features.heredoc && scan.heredocs.length === 0;
  const echoed: string[] = [];
  for (const [index, segment] of scan.segments.entries()) {
    for (const form of effectiveForms(segment, [])) {
      // A here-string's word is among the operands; with one, a shell given
      // no `-c` is read as running it.
      if (hereStrings && shellWithoutString(form)) code.push(...argsOf(form).filter((arg) => !isFlag(arg)));
      if (!shellReadsStdin(form)) continue;
      for (const heredoc of scan.heredocs) if (heredoc.segment === index) code.push(heredoc.body);
      code.push(...echoed);
    }
    const name = commandOf(segment);
    if (name === "echo" || name === "printf") echoed.push(argsOf(segment).filter((arg) => !arg.startsWith("-")).join(" "));
  }
  return code.filter((text) => text.trim() !== "");
}

/**
 * The first hard pattern this command matches, looking through wrappers and
 * into shell strings.
 *
 * Every segment is tried as written and in each unwrapped form, against the
 * raw patterns and the token patterns. A segment that is `sh -c <string>` or
 * `eval …` has its string scanned the same way, as is the code in every
 * substitution and any script fed to a shell on stdin, to `MAX_NESTING` deep:
 * `sudo bash -c 'rm -rf ~'` is `rm -rf ~` and has to trip like it.
 */
function hardPatternHit(command: string, scan: BashScan, depth = 0): { name: string; reason: string } | undefined {
  for (const [name, reason, pattern] of RAW_HARD_PATTERNS) {
    if (pattern.test(command)) return { name, reason };
  }
  const flat = flatten(scan);
  /** Wide targets echoed by earlier segments, for `xargs`. */
  const fed: string[] = [];
  /** An earlier `cd` put the shell somewhere wide, so `rm -rf *` is `rm -rf <wide>`. */
  let hereWide = false;
  for (const segment of scan.segments) {
    const landed = cdLandsWide(segment);
    if (landed !== undefined) hereWide = landed;
    for (const form of effectiveForms(segment, fed)) {
      for (const hard of HARD_PATTERNS) {
        if (hard.matches(form, flat)) return { name: hard.name, reason: hard.reason };
      }
      if (findWideDelete(form) || (hereWide && rmHere(form))) return { name: "rm-rf-wide", reason: RM_RF_WIDE_REASON };
      const inner = shellString(form);
      if (inner !== undefined) {
        if (depth >= MAX_NESTING) return NESTING_TOO_DEEP;
        const hit = hardPatternHit(inner, scanBash(inner), depth + 1);
        if (hit !== undefined) return hit;
      }
    }
    const name = commandOf(segment);
    if (name === "echo" || name === "printf") fed.push(...argsOf(segment).filter((arg) => isWideTarget(arg)));
  }
  for (const inner of hiddenCode(command, scan)) {
    if (depth >= MAX_NESTING) return NESTING_TOO_DEEP;
    const hit = hardPatternHit(inner, scanBash(inner), depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// ------------------------------------------------------------- the allowlist

/**
 * Environment assignments that are safe to see in front of a command.
 *
 * The allowlist exists because `PATH=/evil ls` and `LD_PRELOAD=x ls` run
 * something other than `ls`, and `GIT_SSH_COMMAND=x git log` runs `x`. An
 * assignment is a way to replace the program, so only names that cannot
 * change what executes are permitted.
 */
const BENIGN_ASSIGNMENTS =
  /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|CLICOLOR|CLICOLOR_FORCE|DEBUG|TZ|LANG|LANGUAGE|LC_[A-Z_]+|RUST_BACKTRACE|TERM|COLUMNS|LINES)$/;

/**
 * Directories whose contents are the system's own tools. A command spelled
 * with a path is only the command it looks like if it comes from one of these:
 * `/tmp/evil/ls` and `./ls` are not `ls`.
 */
const SYSTEM_BINS = new Set(["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/sbin", "/usr/sbin"]);

/** Leading `FOO=bar` assignments are not the command. */
function indexOfCommand(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] as string)) index += 1;
  return index;
}

/** The names of the leading assignments, in order. */
function assignmentNames(tokens: string[]): string[] {
  return tokens.slice(0, indexOfCommand(tokens)).map((token) => token.slice(0, token.indexOf("=")));
}

/** `true` when the command word names a path outside the system bin dirs. */
function isForeignPath(tokens: string[]): boolean {
  const raw = tokens[indexOfCommand(tokens)] ?? "";
  if (!raw.includes("/")) return false;
  const slash = raw.lastIndexOf("/");
  const dir = raw.slice(0, slash) === "" ? "/" : raw.slice(0, slash);
  return !SYSTEM_BINS.has(dir);
}

function commandOf(tokens: string[]): string {
  const raw = tokens[indexOfCommand(tokens)] ?? "";
  // `/usr/bin/git` is git. `/tmp/evil/git` is not, but naming it `git` here is
  // still right: `isForeignPath` rejects it, and a hard pattern should match on
  // the name whatever directory it was spelled with.
  const base = raw.split("/").pop() ?? raw;
  return base.toLowerCase();
}

function argsOf(tokens: string[]): string[] {
  return tokens.slice(indexOfCommand(tokens) + 1);
}

/**
 * Long options that hand a read-only-looking command the ability to execute
 * something else or write a file. None of them appears benignly anywhere on
 * the allowlist, so they are rejected across the board rather than per command:
 * `git -c core.pager=…`, `rg --pre`, `ag --pager`, `sort --output`,
 * `git log --ext-diff` and friends are all the same mistake.
 */
const EXEC_OPTIONS = new Set([
  "--pager",
  "--pre",
  "--pre-glob",
  "--hostname-bin",
  "--exec",
  "--execdir",
  "--textconv",
  "--ext-diff",
  "--config-env",
  "--exec-path",
  "--in-place",
  "--inplace",
  "--set",
  "--output",
  "--upload-pack",
  "--receive-pack",
  "--filter-process",
]);

/** The first exec-enabling long option in `args`, if any. */
function execOption(args: string[]): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (EXEC_OPTIONS.has(name)) return name;
  }
  return undefined;
}

/**
 * The first argument that names something secret, if any.
 *
 * `cat` is read-only and `cat ~/.ssh/id_rsa` is an exfiltration step. The
 * predicate is the same one the file-tool prefilter uses, so the two agree by
 * construction; it matches on basenames and path segments, so it needs no
 * expansion of `~` and no `cwd` (a `$HOME`-spelled path sets the expansion
 * flag and is judged before this runs).
 */
function secretArgument(args: string[]): string | undefined {
  for (const arg of args) {
    if (isSensitivePath(arg)) return arg;
    if (arg.includes("=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      if (value !== "" && isSensitivePath(value)) return value;
    }
  }
  return undefined;
}

/** Skip the values of flags that take one, so positionals can be counted. */
function positionals(args: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") continue;
    out.push(arg);
  }
  return out;
}

function noFlag(args: string[], ...flags: string[]): boolean {
  return !args.some((arg) => flags.includes(arg));
}

/** First argument that is not a flag. */
function firstWord(args: string[]): string {
  return args.find((arg) => !arg.startsWith("-")) ?? "";
}

const GIT_READ_ONLY = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "rev-parse",
  "rev-list",
  "describe",
  "blame",
  "shortlog",
  "whatchanged",
  "grep",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "cat-file",
  "for-each-ref",
  "symbolic-ref",
  "name-rev",
  "merge-base",
  "count-objects",
  "diff-tree",
  "show-ref",
  "var",
  "version",
]);

const SAFE_SCRIPT = /^(test|tests|check|checks|lint|format|fmt|typecheck|type-check|types|build|coverage|unit|e2e|spec|smoke|verify|audit)([:_-][\w.-]+)*$/;

const RUNNER_SUBCOMMANDS = new Set(["test", "run", "lint", "build", "ls", "list", "why", "outdated", "view", "info"]);

/**
 * Commands whose every invocation is read-only, given that redirects,
 * substitutions and expansions are rejected globally before we get here.
 */
const ALWAYS_READ_ONLY = new Set([
  "ls",
  "ll",
  "cat",
  "bat",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "pwd",
  "echo",
  "printf",
  "which",
  "whereis",
  "stat",
  "du",
  "df",
  "ps",
  "pgrep",
  "uname",
  "whoami",
  "id",
  "uptime",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "cut",
  "tr",
  "column",
  "nl",
  "diff",
  "cmp",
  "jq",
  "md5sum",
  "shasum",
  "sha256sum",
  "cksum",
  "true",
  "false",
  "sleep",
  "seq",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "mypy",
  "tflint",
]);

/** Commands that are read-only only in some shapes. */
const CONDITIONAL: Record<string, (args: string[]) => boolean> = {
  // `find -delete`/`-exec` runs arbitrary work; everything else lists.
  find: (args) => noFlag(args, "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprintf"),
  fd: (args) => noFlag(args, "-x", "--exec", "-X", "--exec-batch"),
  /**
   * `sed` is an editor. `-i` rewrites the file, and the `w` command writes one
   * from inside the script — `sed -e 'w /etc/x' f` and `sed 's/a/b/w out' f`
   * both write, with no flag that says so. Scripts are not parsed here, so the
   * only shape that skips is the one that provably cannot write: `-n` plus a
   * single line-range print.
   */
  sed: (args) => {
    const flags = args.filter((arg) => arg.startsWith("-") && arg !== "-");
    const scripts = args.filter((arg) => !arg.startsWith("-") || arg === "-");
    if (!flags.includes("-n")) return false;
    if (!flags.every((flag) => ["-n", "-E", "-r"].includes(flag))) return false;
    return scripts.length >= 1 && /^\d+(,\d+)?p$/.test(scripts[0] as string);
  },
  /** `command ls` runs ls; only the `-v`/`-V` lookup forms are read-only. */
  command: (args) => {
    const flags = args.filter((arg) => arg.startsWith("-") && arg !== "-");
    return flags.length > 0 && flags.every((flag) => flag === "-v" || flag === "-V");
  },
  /** `sort -o` writes its output to a file. */
  sort: (args) => noFlag(args, "-o", "--output") && !args.some((arg) => arg.startsWith("--output=")),
  /** `uniq [input [output]]`: a second operand is a file it overwrites. */
  uniq: (args) => positionals(args, new Set(["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"])).length <= 1,
  /** `tree -o` writes its listing to a file. */
  tree: (args) => noFlag(args, "-o", "--output") && !args.some((arg) => arg.startsWith("--output=")),
  /** `yq -i` edits in place. */
  yq: (args) => noFlag(args, "-i", "--inplace", "--in-place"),
  /** `date -s` sets the system clock; a non-format operand does the same. */
  date: (args) => {
    if (!noFlag(args, "-s", "--set")) return false;
    const rest = positionals(args, new Set(["-r", "-d", "-f", "-j", "--date", "--file", "--reference"]));
    return rest.every((arg) => arg.startsWith("+"));
  },
  /** `hostname newname` renames the machine. */
  hostname: (args) =>
    args.every((arg) =>
      ["-s", "-f", "-i", "-d", "-I", "--short", "--fqdn", "--domain", "--all-ip-addresses"].includes(arg),
    ),
  /** `file -C` compiles and writes a magic database. */
  file: (args) => noFlag(args, "-C", "--compile"),
  /**
   * `tsc` emits files, which the spec allows: compiling into the project's own
   * configured output directory is ordinary build work. An explicit output
   * path is not — `tsc --outDir /etc/x` is a write to wherever it says.
   */
  tsc: (args) =>
    !args.some((arg) =>
      ["--outdir", "--outfile", "--declarationdir", "--tsbuildinfofile"].includes(
        (arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg).toLowerCase(),
      ),
    ),
  git: (args) => {
    // Walk git's own global flags. `-c k=v`, `--config-env` and `--exec-path`
    // all let a config value run a command (`-c core.pager='sh -c …'`), so a
    // global flag region containing one is never read-only. `-C <path>` only
    // moves the repository and is fine.
    let index = 0;
    while (index < args.length) {
      const arg = args[index] as string;
      if (arg === "-c" || arg === "--config-env" || arg === "--exec-path") return false;
      if (arg.startsWith("--config-env=") || arg.startsWith("--exec-path=")) return false;
      if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
        index += 2;
        continue;
      }
      if (arg.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }
    const sub = args[index];
    if (sub === undefined) return true; // bare `git` prints usage.
    const rest = args.slice(index + 1);
    if (GIT_READ_ONLY.has(sub)) {
      if (sub === "branch") return !rest.some((arg) => /^-(d|D|m|M|f|c|C)$/.test(arg) || arg.startsWith("--delete") || arg.startsWith("--move") || arg.startsWith("--force"));
      return true;
    }
    if (sub === "remote") return rest.length === 0 || rest.every((arg) => arg === "-v" || arg === "--verbose" || arg === "show" || !arg.startsWith("-"));
    if (sub === "config") return rest.some((arg) => arg === "--get" || arg === "--get-all" || arg === "--list" || arg === "-l");
    if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
    if (sub === "tag") return rest.length === 0 || rest.every((arg) => arg === "-l" || arg === "--list" || arg === "-n");
    if (sub === "worktree") return rest[0] === "list";
    if (sub === "reflog") return rest.length === 0 || rest[0] === "show";
    if (sub === "notes") return rest[0] === "list" || rest[0] === "show";
    return false;
  },
  npm: (args) => runnerIsReadOnly(args),
  pnpm: (args) => runnerIsReadOnly(args),
  yarn: (args) => runnerIsReadOnly(args),
  bun: (args) => runnerIsReadOnly(args),
  cargo: (args) => {
    const sub = firstWord(args) || args[0] || "";
    if (sub === "fmt") return args.includes("--check");
    return ["check", "build", "test", "clippy", "tree", "metadata", "--version", "-V"].includes(sub);
  },
  go: (args) => ["build", "test", "vet", "list", "version", "env"].includes(firstWord(args)),
  ruff: (args) => firstWord(args) === "check" && noFlag(args, "--fix"),
  eslint: (args) => noFlag(args, "--fix"),
  prettier: (args) => args.some((arg) => arg === "--check" || arg === "-c" || arg === "-l" || arg === "--list-different"),
  // An interpreter runs whatever you hand it. Only version probes are safe.
  node: (args) => args.length === 1 && ["--version", "-v"].includes(args[0] as string),
  python: (args) => pythonIsReadOnly(args),
  python3: (args) => pythonIsReadOnly(args),
  deno: (args) => ["check", "fmt", "lint", "--version"].includes(firstWord(args) || args[0] || ""),
  docker: (args) => ["ps", "images", "version", "info"].includes(firstWord(args)),
  /** `kubectl get secret …` prints the secret. Reading one is a decision. */
  kubectl: (args) =>
    ["get", "describe", "logs", "version"].includes(firstWord(args)) &&
    !args.some((arg) => /(^|[^a-z])secrets?($|[^a-z])/i.test(arg)),
};

/**
 * Commands that are never skipped, whatever their arguments.
 *
 * `env` and `printenv` are both: a wrapper that runs another program
 * (`env FOO=bar rm -rf build`) and a way to print the whole environment,
 * which in a Claude Code session is where the API keys live.
 */
const NEVER_SKIP: Record<string, string> = {
  env: "env runs another program and prints the environment",
  printenv: "printenv prints environment variables, which is where secrets live",
};

function runnerIsReadOnly(args: string[]): boolean {
  const first = firstWord(args);
  if (first === "") return true;
  if (!RUNNER_SUBCOMMANDS.has(first)) return false;
  if (first === "run") {
    const script = args[args.indexOf(first) + 1];
    return script !== undefined && SAFE_SCRIPT.test(script);
  }
  if (first === "test" || first === "lint" || first === "build") return true;
  return true;
}

function pythonIsReadOnly(args: string[]): boolean {
  if (args.length === 1 && ["--version", "-V"].includes(args[0] as string)) return true;
  return args[0] === "-m" && ["pytest", "unittest", "mypy", "ruff"].includes(args[1] ?? "");
}

/** Shells and interpreters: a pipe into one of these is arbitrary execution. */
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "powershell",
  "pwsh",
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
  "osascript",
  "eval",
  "exec",
  "source",
  ".",
]);

const PRIVILEGE = new Set(["sudo", "doas", "su", "runas", "pkexec"]);

// ------------------------------------------------- writes equivalent to an Edit

/**
 * `sed` script shapes that provably cannot write a file of their own.
 *
 * `sed` is an editor with two ways to write that no flag announces: the `w`
 * command (`sed -e 'w /etc/x'`) and the `w` flag on a substitution
 * (`sed 's/a/b/w out'`). Rather than parse sed scripts, only these shapes are
 * accepted, which covers what an agent actually types and refuses the rest.
 */
const SAFE_SED_COMMAND = [
  // s/a/b/ with flags that are not `w` or `e`, any single-char delimiter.
  /^s(.)(?:(?!\1)[^])*\1(?:(?!\1)[^])*\1[gilmpIMD0-9]*$/,
  // Address-only delete or print: `3d`, `1,$p`, `/re/d`.
  /^[0-9,$~+]*[dpq=]$/,
  /^\/(?:[^/\\]|\\.)*\/[dpq]$/,
] as const;

export function sedScriptIsSafe(script: string): boolean {
  const parts = script
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return false;
  return parts.every((part) => SAFE_SED_COMMAND.some((pattern) => pattern.test(part)));
}

/** `-i` may carry its backup suffix attached (`-i.bak`) or as an operand (`-i ''`). */
function sedInPlace(args: string[]): boolean {
  return args.some((arg) => arg === "-i" || /^-i[^-]*$/.test(arg) || arg === "--in-place" || arg.startsWith("--in-place="));
}

/**
 * The files a write-equivalent command edits, or `undefined` when the command
 * is not one, or is one in a shape this code will not vouch for.
 */
function writeTargetsOf(command_: string, args: string[]): string[] | undefined {
  if (command_ === "tee") {
    // `tee` with no operand writes stdout only; every operand is a file.
    const files = args.filter((arg) => !arg.startsWith("-") || arg === "-");
    const flags = args.filter((arg) => arg.startsWith("-") && arg !== "-");
    if (!flags.every((flag) => ["-a", "--append", "-i", "--ignore-interrupts", "-p"].includes(flag))) return undefined;
    return files;
  }

  if (command_ === "sed") {
    if (!sedInPlace(args)) return undefined;
    const allowed = /^(-i[^-]*|--in-place(=.*)?|-e|--expression(=.*)?|-E|-r|-n|-s|--separate)$/;
    const flags = args.filter((arg) => arg.startsWith("-") && arg !== "-");
    if (!flags.every((flag) => allowed.test(flag))) return undefined;

    // Walk the operands, honouring the flags that take a value.
    const scripts: string[] = [];
    const files: string[] = [];
    let sawExpression = false;
    let expectSuffix = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] as string;
      if (arg === "-e" || arg === "--expression") {
        const script = args[i + 1];
        if (script === undefined) return undefined;
        scripts.push(script);
        sawExpression = true;
        i += 1;
        continue;
      }
      if (arg.startsWith("--expression=")) {
        scripts.push(arg.slice("--expression=".length));
        sawExpression = true;
        continue;
      }
      if (arg === "-i" || arg === "--in-place") {
        // BSD sed takes the backup suffix as the next operand; GNU attaches it.
        // An empty or dot-prefixed next operand is a suffix, never a script.
        const next = args[i + 1];
        if (next !== undefined && (next === "" || next.startsWith("."))) expectSuffix = true;
        continue;
      }
      if (arg.startsWith("-")) continue;
      if (expectSuffix) {
        expectSuffix = false;
        continue;
      }
      if (!sawExpression && scripts.length === 0) scripts.push(arg);
      else files.push(arg);
    }

    if (scripts.length === 0 || files.length === 0) return undefined;
    if (!scripts.every((script) => sedScriptIsSafe(script))) return undefined;
    return files;
  }

  return undefined;
}

/** Resolve a redirect or file operand against `cwd` and test containment. */
function resolvesInside(cwd: string, target: string): boolean {
  const root = resolve(cwd);
  const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);
  return absolute === root || absolute.startsWith(root.endsWith(sep) ? root : root + sep);
}

// ------------------------------------------------------------ self-protection

/**
 * The pattern name for every attempt to switch this plugin off or down.
 *
 * A gate the agent can turn off is not a gate. `/jev:off` is a Bash call to
 * the hook binary, the global off switch is a file in the data directory, and
 * Claude Code's own settings decide whether the hooks run at all — each is a
 * tool call the agent can make, so each is a code-rule trip, and under the
 * default `pattern_trips: ask` it is the user who answers it.
 *
 * `export JEV_HOOKS_DISABLE=1`, `JEV_GATE=off` and `JEV_PATTERN_TRIPS=advisory`
 * as shell assignments are deliberately not here: a hook process inherits its
 * environment from Claude Code, not from the agent's shell, so they reach only
 * the agent's own child processes and switch nothing off.
 */
export const SELF_DISABLE_PATTERN = "jev-self-disable";

/** Commands that write, move or remove the file operands they are given. */
const FILE_WRITERS = new Set([
  "rm", "unlink", "shred", "touch", "tee", "cp", "mv", "install", "ln", "truncate", "mkdir", "rmdir", "chmod", "chown",
]);

/**
 * Claude Code's settings files and its plugin registry: `.claude/settings*.json`
 * at any level (the project's, and `~/.claude/`), and `~/.claude/plugins/*.json`
 * (`installed_plugins.json`, `config.json`), which is where a plugin is enabled
 * and where its options live.
 */
function isHarnessConfigPath(path: string): boolean {
  const normalized = `/${path.replace(/\\/g, "/")}`;
  return /\/\.claude\/settings[^/]*\.json$/i.test(normalized) || /\/\.claude\/plugins\/[^/]+\.json$/i.test(normalized);
}

/**
 * This plugin's installed files: anything under a `jev` segment in Claude
 * Code's plugin cache or a marketplace checkout (`~/.claude/plugins/cache/
 * <marketplace>/jev/<version>/…`), the literal `${CLAUDE_PLUGIN_ROOT}` spelling
 * of the same place, and the resolved plugin root when the hook knows it.
 * Rewriting `hook.mjs` or `hooks.json` there is rewriting the gate itself.
 */
function isJevPluginPath(path: string, options: FilePrefilterOptions): boolean {
  const normalized = `/${path.replace(/\\/g, "/")}`;
  if (/\/\.claude\/plugins\/(?:cache|marketplaces)\/(?:[^/]+\/)*jev(?:\/|$)/i.test(normalized)) return true;
  if (/^\$\{?CLAUDE_PLUGIN_ROOT\}?(?:\/|$)/.test(path)) return true;
  return options.pluginRoot !== undefined && targetsDir(options.pluginRoot, options.cwd, path);
}

/**
 * Claude Code's plugin registry. No word filter here, unlike the settings
 * files: these two hold nothing but which plugins are installed and enabled,
 * so any write to them is about plugins.
 */
function isPluginRegistryPath(path: string): boolean {
  return /\/\.claude\/plugins\/(?:installed_plugins|known_marketplaces)\.json$/i.test(`/${path.replace(/\\/g, "/")}`);
}

/** The reason a write to `target` would switch this plugin off, if it would. */
function selfDisableTarget(target: string, command: string, options: FilePrefilterOptions): string | undefined {
  if (options.dataDir !== undefined && targetsDir(options.dataDir, options.cwd, target)) {
    return "writing inside this plugin's data directory, where its off switch and its log live";
  }
  if (isJevPluginPath(target, options)) return "writing into this plugin's installed files";
  if (isPluginRegistryPath(target)) return "writing Claude Code's plugin registry";
  if (isHarnessConfigPath(target) && SELF_DISABLE_WORDS.test(command)) {
    return "writing Claude Code settings in a way that names this plugin's hooks";
  }
  return undefined;
}

/** Does this command write, move or remove its file operands? `sed` only with `-i`. */
function writesOperands(tokens: string[]): boolean {
  const name = commandOf(tokens);
  if (FILE_WRITERS.has(name)) return true;
  return name === "sed" && sedInPlace(argsOf(tokens));
}

/** Does a `claude` CLI invocation disable, remove or reconfigure this plugin? */
function claudeCliDisables(tokens: string[]): string | undefined {
  if (commandOf(tokens) !== "claude") return undefined;
  const words = argsOf(tokens).filter((arg) => !arg.startsWith("-"));
  // No name means every plugin, which includes this one.
  const namesJev = (names: string[]): boolean => names.length === 0 || names.some((name) => /jev/i.test(name));
  if (words[0] === "plugin") {
    if (words[1] === "marketplace" && ["remove", "rm", "delete"].includes(words[2] ?? "") && namesJev(words.slice(3))) {
      return "removing the marketplace this plugin is installed from (claude plugin marketplace remove)";
    }
    if (["disable", "uninstall", "remove", "rm"].includes(words[1] ?? "") && namesJev(words.slice(2))) {
      return `turning this plugin off (claude plugin ${words[1] as string})`;
    }
    return undefined;
  }
  // `claude config set|add|remove <key> …`: a key that names the hooks table,
  // the plugin list or this plugin is the same edit as writing settings.json.
  if (words[0] === "config" && ["set", "add", "remove", "rm", "unset"].includes(words[1] ?? "")) {
    if (words.slice(2).some((word) => /hooks|plugins|jev/i.test(word))) {
      return "changing Claude Code configuration that governs this plugin (claude config)";
    }
  }
  return undefined;
}

/**
 * Words in a settings edit that can reach this plugin.
 *
 * Narrow on purpose: a user's settings file is edited for many reasons, and
 * `isSensitivePath` already sends every such edit to judgment. Only an edit
 * that names the plugin, its environment, the plugin list or the hooks table
 * is the one that could switch it off, and that one is the user's decision.
 */
const SELF_DISABLE_WORDS = /jev|JEV_|TYPESAFE_|disableAllHooks|enabledPlugins|hooks/i;

/**
 * Is `target` inside `dir`, as the shell or a file tool would resolve it?
 *
 * Relative paths resolve against `cwd`. `~/…`, `$HOME/…` and `${HOME}/…` have
 * no home to expand against here, so they are matched by shape: the data
 * directory lives at `~/.claude/plugins/data/<id>`, and when `dir` has that
 * `.claude` tail the home-relative spelling of it is known exactly. A data
 * directory somewhere else (a hand-wired `CLAUDE_PLUGIN_DATA`) has no known
 * home-relative spelling, and a `~` path is then not matched at all.
 */
function targetsDir(dir: string, cwd: string, target: string): boolean {
  const homeish = /^(?:~|\$HOME|\$\{HOME\})\/(.*)$/.exec(target);
  if (homeish !== null) {
    const root = resolve(dir).replace(/\\/g, "/");
    const dot = root.indexOf("/.claude/");
    if (dot === -1) return false;
    const known = root.slice(dot + 1);
    const given = (homeish[1] as string).split("/").filter((part) => part !== "" && part !== ".").join("/");
    return given === known || given.startsWith(`${known}/`);
  }
  return resolvesInside(dir, isAbsolute(target) ? target : resolve(cwd, target));
}

/**
 * The reason a Bash command trips `jev-self-disable`, or `undefined`.
 *
 * Looks through wrappers and into `sh -c`/`eval` strings exactly as
 * `hardPatternHit` does, for the same reason: `bash -c 'node hook.mjs
 * disable'` is `node hook.mjs disable`.
 */
function selfDisableBash(command: string, scan: BashScan, options: FilePrefilterOptions, depth = 0): string | undefined {
  for (const segment of scan.segments) {
    for (const form of effectiveForms(segment, [])) {
      // `node …/dist/hook.mjs disable [session]` is `/jev:off`. `enable`,
      // `status`, `why` and `calibrate` only read or restore, and stay free.
      const binary = form.findIndex((token) => /(^|[\\/])hook\.mjs$/i.test(token));
      if (binary !== -1 && form[binary + 1] === "disable") return "turning this plugin's hooks off (hook.mjs disable)";
      // `daemon-ctl stop|restart` leaves the http hooks with nobody to post to
      // until the watchdog's next pass, about ten seconds: a window the agent
      // must not be able to open for itself. `/jev:daemon restart` typed by the
      // user runs through the Bash tool and is asked about like any other.
      if (binary !== -1 && form[binary + 1] === "daemon-ctl" && ["stop", "restart"].includes(form[binary + 2] ?? "")) {
        return `stopping this plugin's daemon (daemon-ctl ${form[binary + 2] as string})`;
      }
      const cli = claudeCliDisables(form);
      if (cli !== undefined) return cli;

      if (depth < MAX_NESTING) {
        const inner = shellString(form);
        if (inner !== undefined) {
          const hit = selfDisableBash(inner, scanBash(inner), options, depth + 1);
          if (hit !== undefined) return hit;
        }
      }

      if (!writesOperands(form)) continue;
      for (const arg of argsOf(form)) {
        if (arg.startsWith("-")) continue;
        const hit = selfDisableTarget(arg, command, options);
        if (hit !== undefined) return hit;
      }
    }
  }
  for (const redirect of scan.redirects) {
    if (redirect.special || redirect.target === "") continue;
    const hit = selfDisableTarget(redirect.target, command, options);
    if (hit !== undefined) return hit;
  }
  // Past the limit, `hardPatternHit` has already tripped `nesting-too-deep`.
  if (depth < MAX_NESTING) {
    for (const inner of hiddenCode(command, scan)) {
      const hit = selfDisableBash(inner, scanBash(inner), options, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** Every string a file tool's input would write, joined for a word search. */
function editText(toolInput: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["content", "old_string", "new_string", "new_source"]) {
    const value = toolInput[key];
    if (typeof value === "string") parts.push(value);
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits as unknown[]) {
      if (typeof edit !== "object" || edit === null) continue;
      for (const key of ["old_string", "new_string"]) {
        const value = (edit as Record<string, unknown>)[key];
        if (typeof value === "string") parts.push(value);
      }
    }
  }
  return parts.join("\n");
}

/** The reason a file-tool call trips `jev-self-disable`, or `undefined`. */
function selfDisableFile(path: string, toolInput: Record<string, unknown>, options: FilePrefilterOptions): string | undefined {
  // The edit text stands in for the command text of the Bash form: the
  // settings-file word filter reads what would be written.
  return selfDisableTarget(path, editText(toolInput), options);
}

/**
 * Classify one Bash command.
 *
 * `skip` requires every segment to be recognizably read-only *and* the whole
 * command to be free of substitutions, variable expansion, grouping, privilege
 * escalation, and pipes into an interpreter.
 *
 * With `options`, one more shape skips: a command whose only effect beyond
 * reading is writing files inside `cwd` — an output redirect, `sed -i`, `tee`,
 * or a `cat > file <<'EOF'` heredoc. Those are Edits spelled as shell, and
 * prompting for them while the Edit tool itself is silent taught users to stop
 * reading prompts. Without `options` there is no `cwd` to judge a target
 * against, so a redirect stays `judge` exactly as in 0.1.x.
 */
export function prefilterBash(
  command: string,
  options?: FilePrefilterOptions,
): Exclude<Prefilter, { kind: "affirm" }> {
  const scan = scanBash(command);

  const hit = hardPatternHit(command, scan);
  if (hit !== undefined) return { kind: "escalate", reason: hit.reason, pattern: hit.name };
  if (options !== undefined) {
    const self = selfDisableBash(command, scan, options);
    if (self !== undefined) return { kind: "escalate", reason: self, pattern: SELF_DISABLE_PATTERN };
  }

  if (scan.segments.length === 0) return { kind: "skip", reason: "empty command" };
  if (scan.features.unbalanced) return { kind: "judge", reason: "unbalanced quoting" };
  if (scan.features.substitution) return { kind: "judge", reason: "command substitution" };
  if (scan.features.grouping) return { kind: "judge", reason: "subshell or group" };
  if (scan.features.expansion) return { kind: "judge", reason: "variable expansion" };

  // Files this command would write, collected as they are recognized. Any
  // write this code cannot account for returns `judge` on the spot.
  const writes: string[] = [];
  const fileWrites = scan.redirects.filter((redirect) => !redirect.special);

  if (options === undefined) {
    // No cwd to resolve a target against: 0.1.x behaviour, unchanged.
    if (scan.features.redirect) return { kind: "judge", reason: "output redirect" };
    if (scan.features.heredoc) return { kind: "judge", reason: "here-document" };
  } else {
    for (const redirect of fileWrites) {
      if (redirect.target === "") return { kind: "judge", reason: "output redirect with no target" };
      writes.push(redirect.target);
    }
    // A here-string is not consumed as data, so its words are still tokens.
    const herestrings = scan.features.heredoc && scan.heredocs.length === 0;
    if (herestrings) return { kind: "judge", reason: "here-string" };
  }

  for (const [index, segment] of scan.segments.entries()) {
    const command_ = commandOf(segment);
    if (command_ === "") return { kind: "judge", reason: "unparsed segment" };

    // An assignment or a path can replace the program before any allowlist
    // gets a say, so both are checked before the name means anything.
    for (const name of assignmentNames(segment)) {
      if (!BENIGN_ASSIGNMENTS.test(name)) {
        return { kind: "judge", reason: `environment assignment (${name}=) before the command` };
      }
    }
    if (isForeignPath(segment)) {
      return { kind: "judge", reason: `command is path-qualified outside the system bin directories` };
    }

    if (PRIVILEGE.has(command_)) return { kind: "judge", reason: `privilege escalation (${command_})` };
    if (index > 0 && INTERPRETERS.has(command_)) {
      return { kind: "judge", reason: `pipes into an interpreter (${command_})` };
    }
    const never = NEVER_SKIP[command_];
    if (never !== undefined) return { kind: "judge", reason: never };

    const args = argsOf(segment);
    const exec = execOption(args);
    if (exec !== undefined) return { kind: "judge", reason: `${exec} can run a command or write a file` };
    const secret = secretArgument(args);
    if (secret !== undefined) return { kind: "judge", reason: `argument names sensitive material (${secret})` };

    // A command whose whole job is writing a file the caller named: the same
    // thing the Edit tool does, so it gets the same verdict — but only when
    // there is a cwd to resolve its operands against.
    if (options !== undefined) {
      const targets = writeTargetsOf(command_, args);
      if (targets !== undefined) {
        writes.push(...targets.filter((target) => target !== "-"));
        continue;
      }
    }

    const conditional = CONDITIONAL[command_];
    if (conditional !== undefined) {
      if (!conditional(args)) return { kind: "judge", reason: `${command_} invoked in a non-read-only shape` };
      continue;
    }
    if (!ALWAYS_READ_ONLY.has(command_)) {
      return { kind: "judge", reason: `${command_} is not on the read-only allowlist` };
    }
  }

  if (writes.length === 0) return { kind: "skip", reason: "every segment is a read-only allowlisted command" };

  // Every other segment reads, and the writes are all accounted for. Now they
  // have to land somewhere ordinary, or this is a decision for a human.
  const cwd = (options as FilePrefilterOptions).cwd;
  for (const target of writes) {
    if (isSensitivePath(target)) {
      return { kind: "judge", reason: `writes a sensitive path (${target})`, writesInProject: false };
    }
    if (!resolvesInside(cwd, target)) {
      return { kind: "judge", reason: `writes outside the working directory (${target})`, writesInProject: false };
    }
  }

  const plural = writes.length === 1 ? "" : "s";
  if ((options as FilePrefilterOptions).strict) {
    return { kind: "judge", reason: `strict mode judges every edit`, writesInProject: true };
  }
  return {
    kind: "skip",
    reason: `writes ${writes.length} ordinary file${plural} inside the working directory`,
    writesInProject: true,
  };
}

// --------------------------------------------------------------- file writing

/**
 * Containment, for both absolute and relative paths.
 *
 * A relative path resolves against `cwd`, which is usually inside it — but
 * `../../etc/passwd` is relative too, so it is resolved rather than assumed.
 */
export function isInside(cwd: string, path: string): boolean {
  return resolvesInside(cwd, path);
}

export interface FilePrefilterOptions {
  cwd: string;
  /** strict mode judges even an ordinary in-cwd edit. */
  strict: boolean;
  /**
   * This plugin's own data directory, so a write into it can trip
   * `jev-self-disable`. Optional because callers that only want the
   * read-only/edit classification (the verification ledger) have no use for it.
   */
  dataDir?: string;
  /** `CLAUDE_PLUGIN_ROOT` as the hook process sees it: where `hook.mjs` lives. */
  pluginRoot?: string;
}

export function prefilterFileWrite(path: string | undefined, options: FilePrefilterOptions): Prefilter {
  if (path === undefined || path === "") return { kind: "judge", reason: "no file path in the tool input" };
  if (isSensitivePath(path)) return { kind: "judge", reason: "sensitive path" };
  if (!isInside(options.cwd, path)) return { kind: "judge", reason: "path outside the working directory" };
  if (options.strict) return { kind: "judge", reason: "strict mode judges every edit", writesInProject: true };
  return { kind: "skip", reason: "ordinary file inside the working directory", writesInProject: true };
}

// ------------------------------------------------------- the judged action

/** Longest `content_head` a Write sends. */
const MAX_CONTENT_HEAD_CHARS = 1500;
/** Longest `old_string`/`new_string` an Edit sends. */
const MAX_EDIT_STRING_CHARS = 1000;
/** Longest serialized `input` an MCP or notebook call sends. */
const MAX_TOOL_INPUT_CHARS = 2500;
/** Longest single target path. A longer one is a path plus noise. */
const MAX_TARGET_PATH_CHARS = 200;
/** Beyond this many targets, more paths cost tokens and add no scope. */
export const MAX_TARGET_PATHS = 10;

/**
 * A `sed`/`awk` script operand looks like a path because it is full of
 * slashes. `s/a/b/` is not a file, and listing it as a target would have
 * `mentions_target` looking for it in the user's prompts.
 */
const SCRIPT_OPERAND = /^[sy][|/,#:].*[|/,#:]/;

/**
 * Does this argument name a file or a directory?
 *
 * Deliberately generous about URLs: `mentions_target` asks whether a request
 * named the file, command, branch, package, URL or service being acted on, and
 * a posted endpoint is exactly the kind of target the user either typed or did
 * not.
 */
export function isPathLike(token: string): boolean {
  if (token === "" || token.startsWith("-")) return false;
  if (/\s/.test(token)) return false;
  if (SCRIPT_OPERAND.test(token)) return false;
  if (token.includes("/")) return true;
  return /^[\w@][\w.@-]*\.[A-Za-z0-9]{1,8}$/.test(token);
}

/** A path as the user would recognize it: relative to the cwd when it is inside. */
function relativize(cwd: string, path: string): string {
  if (!isAbsolute(path)) return path;
  if (!resolvesInside(cwd, path)) return path;
  const inside = relative(resolve(cwd), resolve(path));
  return inside === "" ? "." : inside;
}

function targetPaths(cwd: string, raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const token of raw) {
    const path = relativize(cwd, token).slice(0, MAX_TARGET_PATH_CHARS);
    if (path !== "" && !out.includes(path)) out.push(path);
    if (out.length >= MAX_TARGET_PATHS) break;
  }
  return out;
}

/** Everything a Bash command names a file: operands, redirects, `sed -i`, `tee`. */
function bashTargets(command: string, cwd: string): string[] {
  const scan = scanBash(command);
  const raw: string[] = [];
  for (const redirect of scan.redirects) {
    if (!redirect.special && redirect.target !== "") raw.push(redirect.target);
  }
  for (const segment of scan.segments) {
    const args = argsOf(segment);
    const writes = writeTargetsOf(commandOf(segment), args);
    if (writes !== undefined) raw.push(...writes.filter((target) => target !== "-"));
    for (const arg of args) {
      if (isPathLike(arg)) raw.push(arg);
    }
  }
  return targetPaths(cwd, raw);
}

/** Path-shaped strings anywhere in a tool input, for MCP calls. */
function inputTargets(value: unknown, cwd: string, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof value === "string") return isPathLike(value) ? targetPaths(cwd, [value]) : [];
  if (Array.isArray(value)) return value.flatMap((item) => inputTargets(item, cwd, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((item) => inputTargets(item, cwd, depth + 1));
  }
  return [];
}

/** The tool input as JSON, with its serialized size bounded. */
function boundedInput(value: unknown, max: number): Record<string, Json> {
  let json: unknown;
  try {
    json = JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return {};
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return {};
  const record = json as Record<string, Json>;
  const serialized = JSON.stringify(record);
  if (serialized.length <= max) return record;
  // Too long to send as structure. The head as one string still answers the
  // questions, and the budget still holds.
  return { truncated_json: serialized.slice(0, max) };
}

function stringField(toolInput: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = toolInput[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * The action, as the fields the gate questions name.
 *
 * Only what the model reads changes: the fingerprint, the memo key and the
 * prefilter all still see the raw tool input, so a tripwire and its re-issue
 * hash identically across this release.
 *
 * Bash `description` is excluded on purpose. It is text the agent wrote about
 * its own call — framing, not evidence — and the jaggedness notes are explicit
 * that self-arguing text moves answers. `mentions_target` and `same_task_area`
 * recover the context it carried from the prompts side instead.
 */
export function structuredAction(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): GateAction {
  const action: GateAction = { tool: toolName, target_paths: [] };

  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = stringField(toolInput, "command");
    if (command !== undefined) {
      action.command = command;
      action.target_paths = bashTargets(command, cwd);
    }
    return action;
  }

  if (toolName === "Write") {
    const path = stringField(toolInput, "file_path", "path");
    const content = stringField(toolInput, "content") ?? "";
    if (path !== undefined) {
      action.file_path = relativize(cwd, path);
      action.target_paths = targetPaths(cwd, [path]);
    }
    action.content_head = content.slice(0, MAX_CONTENT_HEAD_CHARS);
    action.content_chars = content.length;
    return action;
  }

  if (toolName === "Edit" || toolName === "Update") {
    const path = stringField(toolInput, "file_path", "path");
    if (path !== undefined) {
      action.file_path = relativize(cwd, path);
      action.target_paths = targetPaths(cwd, [path]);
    }
    action.old_string = (stringField(toolInput, "old_string") ?? "").slice(0, MAX_EDIT_STRING_CHARS);
    action.new_string = (stringField(toolInput, "new_string") ?? "").slice(0, MAX_EDIT_STRING_CHARS);
    return action;
  }

  if (toolName === "MultiEdit") {
    const path = stringField(toolInput, "file_path", "path");
    if (path !== undefined) {
      action.file_path = relativize(cwd, path);
      action.target_paths = targetPaths(cwd, [path]);
    }
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    action.input = boundedInput({ edits: edits.length, first: edits[0] ?? null }, MAX_TOOL_INPUT_CHARS);
    return action;
  }

  if (toolName === "NotebookEdit") {
    const path = stringField(toolInput, "notebook_path", "file_path", "path");
    if (path !== undefined) {
      action.file_path = relativize(cwd, path);
      action.target_paths = targetPaths(cwd, [path]);
    }
    action.input = boundedInput(toolInput, MAX_TOOL_INPUT_CHARS);
    return action;
  }

  // MCP, and anything else with no shape this code knows.
  action.input = boundedInput(toolInput, MAX_TOOL_INPUT_CHARS);
  action.target_paths = inputTargets(toolInput, cwd).slice(0, MAX_TARGET_PATHS);
  return action;
}

// ----------------------------------------------------------------- mcp tools

const READ_VERBS = /^(get|list|read|search|query|fetch|describe|find|show|view|inspect|count|resolve)/;

/** `mcp__<server>__<tool>`, or `mcp__plugin_<plugin>_<server>__<tool>`. */
export function mcpToolSegment(toolName: string): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const parts = toolName.split("__");
  return parts[parts.length - 1];
}

export function prefilterMcp(toolName: string): Prefilter {
  const tool = mcpToolSegment(toolName);
  if (tool === undefined) return { kind: "judge", reason: "not an MCP tool name" };
  if (READ_VERBS.test(tool.toLowerCase())) {
    return { kind: "skip", reason: "MCP tool name reads as a retrieval" };
  }
  return { kind: "judge", reason: "MCP tool with an unknown effect" };
}

/** This plugin's own tools, whether reached bare or through its bundled server. */
export function isOwnTool(toolName: string): boolean {
  return /^mcp__[a-z0-9_]*jev[a-z0-9_]*__jev_/i.test(toolName);
}

// ------------------------------------------------------------------ dispatch

export interface PrefilterInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  strict: boolean;
  /** This plugin's data directory, for `jev-self-disable`. */
  dataDir?: string;
  /** This plugin's install directory (`CLAUDE_PLUGIN_ROOT`), for `jev-self-disable`. */
  pluginRoot?: string;
}

export const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Update"]);

/**
 * Take the affirmation marker off a Bash command, if it has one.
 *
 * The marker has to come off *before* tokenizing, not after: `scanBash` has no
 * notion of a `#` comment, so a marker left in place becomes tokens, and tokens
 * change verdicts — `rm -rf ~/ # jev:intended …` would have `#` among its
 * operands, and a marker's words could land on an allowlist check. Stripping
 * first also means the fingerprint, the action sent to Jev and the verification
 * ledger all see the identical command.
 *
 * A marker inside an unterminated quote is not a marker: if removing it leaves
 * the command unbalanced, the `#` was quoted text and the command is returned
 * untouched.
 */
export function readBashMarker(command: string): { command: string; marker?: AffirmationMarker } {
  const parsed = parseMarker(command);
  if (parsed.marker === undefined) return { command };
  if (scanBash(parsed.stripped).features.unbalanced) return { command };
  return { command: parsed.stripped, marker: parsed.marker };
}

/** Spawning a subagent. Not judged; captured, so the subagent has a request. */
export const SPAWN_TOOLS = new Set(["Agent", "Task"]);

export function prefilter(input: PrefilterInput): Prefilter {
  const { toolName } = input;
  if (isOwnTool(toolName)) return { kind: "skip", reason: "this plugin's own tool" };

  // A spawn is bookkeeping, never a judgment: the handler records the task the
  // parent just handed the subagent so the subagent's own calls have something
  // to be in scope *of*. No model, no output.
  if (SPAWN_TOOLS.has(toolName)) return { kind: "skip", reason: "subagent spawn" };

  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = input.toolInput.command;
    if (typeof command !== "string" || command.trim() === "") {
      return { kind: "judge", reason: "no command in the tool input" };
    }

    const reading = readBashMarker(command);
    const found: Omit<PrefilterCommon, "reason"> =
      reading.marker === undefined
        ? {}
        : { marker: reading.marker, stripped: { ...input.toolInput, command: reading.command } };

    if (reading.marker !== undefined && isSidecarBody(reading.command)) {
      return { ...found, kind: "affirm", reason: "sidecar affirmation" };
    }
    if (toolName === "PowerShell") {
      return { ...found, kind: "judge", reason: "PowerShell is not tokenized here" };
    }
    const options: FilePrefilterOptions = { cwd: input.cwd, strict: input.strict };
    if (input.dataDir !== undefined) options.dataDir = input.dataDir;
    if (input.pluginRoot !== undefined) options.pluginRoot = input.pluginRoot;
    return { ...prefilterBash(reading.command, options), ...found };
  }

  if (FILE_TOOLS.has(toolName)) {
    const path = input.toolInput.file_path ?? input.toolInput.notebook_path ?? input.toolInput.path;
    const options: FilePrefilterOptions = { cwd: input.cwd, strict: input.strict };
    if (input.dataDir !== undefined) options.dataDir = input.dataDir;
    if (input.pluginRoot !== undefined) options.pluginRoot = input.pluginRoot;
    // A write that reaches this plugin's own off switch or the harness
    // settings is a code-rule trip before it is anything else.
    if (typeof path === "string" && path !== "") {
      const self = selfDisableFile(path, input.toolInput, options);
      if (self !== undefined) return { kind: "escalate", reason: self, pattern: SELF_DISABLE_PATTERN };
    }
    return prefilterFileWrite(typeof path === "string" ? path : undefined, options);
  }

  if (toolName.startsWith("mcp__")) return prefilterMcp(toolName);

  return { kind: "judge", reason: "tool has no prefilter" };
}
