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

function isHomeish(target: string): boolean {
  return /^(~|\$HOME|\$\{HOME\})(\/\*?)?$/.test(target);
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
    reason: "recursive delete of a home, root, or parent-escaping path",
    matches: (tokens) => {
      const command = commandOf(tokens);
      if (command !== "rm") return false;
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
      if (!recursive) return false;
      return operands.some((target) => isRoot(target) || isHomeish(target) || escapesUp(target));
    },
  },
  {
    name: "git-force-push-main",
    reason: "force push to a main branch",
    matches: (tokens) => {
      if (commandOf(tokens) !== "git" || !tokens.includes("push")) return false;
      const forced = tokens.some((t) => t === "--force" || t === "-f" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t));
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
      const recursive = tokens.some((t) => t === "-R" || t === "-r" || t === "--recursive");
      return recursive && tokens.some((t) => /^0?777$/.test(t) || /^a\+?rwx$/.test(t) || /^a=rwx$/.test(t));
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
  const flat = flatten(scan);

  for (const [name, reason, pattern] of RAW_HARD_PATTERNS) {
    if (pattern.test(command)) {
      return { kind: "escalate", reason, pattern: name };
    }
  }
  for (const segment of scan.segments) {
    for (const hard of HARD_PATTERNS) {
      if (hard.matches(segment, flat)) {
        return { kind: "escalate", reason: hard.reason, pattern: hard.name };
      }
    }
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
    return { ...prefilterBash(reading.command, { cwd: input.cwd, strict: input.strict }), ...found };
  }

  if (FILE_TOOLS.has(toolName)) {
    const path = input.toolInput.file_path ?? input.toolInput.notebook_path ?? input.toolInput.path;
    return prefilterFileWrite(typeof path === "string" ? path : undefined, {
      cwd: input.cwd,
      strict: input.strict,
    });
  }

  if (toolName.startsWith("mcp__")) return prefilterMcp(toolName);

  return { kind: "judge", reason: "tool has no prefilter" };
}
