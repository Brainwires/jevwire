/**
 * Hook configuration, read from the environment.
 *
 * Claude Code exports each plugin `userConfig` value to hook processes as
 * `CLAUDE_PLUGIN_OPTION_<KEY>`; a shell-form hook command cannot interpolate
 * `${user_config.*}` at all, so the environment is the only channel. Every
 * option also has a `JEV_*` fallback so the hooks work when the code is wired
 * up by hand rather than installed as a plugin.
 *
 * Nothing here throws. A hook that dies on a malformed option is a hook that
 * breaks someone's session over a typo, so every value falls back to its
 * default and the fact is recorded in `warnings`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_IDLE_MS, DEFAULT_PORT } from "./daemon/protocol.js";

/**
 * How much the tool gate says.
 *
 * `off`: nothing at all. `advisory`: the default — a note to the agent after
 * the fact, and a tripwire before execution for the two block-grade cases.
 * `strict`: also judges ordinary in-project edits, and notes the cases advisory
 * mode keeps to itself (a local overwrite the user asked for, a firm
 * out-of-scope reading with no risk signal).
 */
export const GATE_LEVELS = ["off", "advisory", "strict"] as const;
export type GateLevel = (typeof GATE_LEVELS)[number];

export const LINT_LEVELS = ["off", "tripwire", "advisory"] as const;
export type LintLevel = (typeof LINT_LEVELS)[number];

/** 0.2.x `gate_mode` values, and what each one means as a `gate`. */
const GATE_MODE_MIGRATION: Record<string, GateLevel> = {
  off: "off",
  standard: "advisory",
  strict: "strict",
};

export interface HookConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  /** Deadline for one Jev call inside a hook. Deliberately short. */
  timeoutMs: number;
  maxRetries: number;
  gate: GateLevel;
  /**
   * The only way a human is ever prompted by this plugin: a tripwire emits
   * `ask` instead of `deny`, in the modes where a prompt has an audience.
   */
  askOnTrip: boolean;
  stopCheck: boolean;
  screenResults: boolean;
  routePrompts: boolean;
  /**
   * Semantic code lint on in-project edits. `tripwire`: only the block-grade
   * checks (a hardcoded secret, a removed test) trip; `advisory`: notes for the
   * rest, the CLAUDE.md conventions and commit scope; `off`: none.
   */
  lint: LintLevel;
  /** Ask one Noul per extracted CLAUDE.md convention line. */
  lintConventions: boolean;
  /** The model half of the Stop claim check (git diff HEAD). Stage 1 is free. */
  verifyClaims: boolean;
  autoThreshold: number;
  reviewThreshold: number;
  /**
   * The bar a Choice answer's `confidence` has to clear.
   *
   * Separate from `autoThreshold` because it is a different kind of quantity.
   * A Noul's `P(yes)` and a Score level's mass are both probabilities of a
   * binary event, so they share `auto`/`review`; a Choice's `confidence` is a
   * peakedness statistic over the option distribution, and holding it to a
   * probability threshold is a category error that happens to compile.
   */
  confidenceThreshold: number;
  /**
   * Loopback port the daemon listens on.
   *
   * `hooks.json` can interpolate environment variables into *headers* only, so
   * the URL in the manifest carries the literal default and this setting exists
   * for tests and for a hand-wired install. Changing it without changing the
   * manifest moves the daemon somewhere the http hooks do not look.
   */
  daemonPort: number;
  /** No request for this long and the daemon exits rather than sit resident. */
  daemonIdleMs: number;
  /** Directory for session files and the decision log. */
  dataDir: string;
  /** `JEV_HOOKS_DISABLE=1`: every hook becomes a no-op. */
  disabled: boolean;
  /** Malformed option values, for `/jev:status`. */
  warnings: string[];
}

export const HOOK_DEFAULTS = {
  baseUrl: "https://api.typesafe.ai",
  /**
   * Pinned, not an alias. `jev-latest` re-points silently when a release
   * ships, and every probability the thresholds here are tuned against moves
   * with it — including the ones `/jev:calibrate` replays over a log captured
   * from a different model. A user who wants to follow releases sets
   * `jev-latest` deliberately.
   */
  model: "jev-1.13.0",
  timeoutMs: 1500,
  maxRetries: 0,
  gate: "advisory" as GateLevel,
  askOnTrip: false,
  stopCheck: true,
  screenResults: true,
  routePrompts: false,
  lint: "advisory" as LintLevel,
  lintConventions: true,
  verifyClaims: true,
  autoThreshold: 0.85,
  reviewThreshold: 0.6,
  confidenceThreshold: 0.85,
  daemonPort: DEFAULT_PORT,
  daemonIdleMs: DEFAULT_IDLE_MS,
} as const;

export type Env = Record<string, string | undefined>;

/** `CLAUDE_PLUGIN_OPTION_<KEY>` first, then the `JEV_*`/legacy names. */
function read(env: Env, option: string, ...fallbacks: string[]): string | undefined {
  for (const key of [`CLAUDE_PLUGIN_OPTION_${option.toUpperCase()}`, ...fallbacks]) {
    const raw = env[key];
    if (raw !== undefined && raw.trim() !== "") return raw.trim();
  }
  return undefined;
}

function readBool(env: Env, option: string, fallback: boolean, warnings: string[], ...aliases: string[]): boolean {
  const raw = read(env, option, ...aliases);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lowered)) return true;
  if (["false", "0", "no", "off"].includes(lowered)) return false;
  warnings.push(`${option}=${JSON.stringify(raw)} is not a boolean; using ${fallback}.`);
  return fallback;
}

function readNumber(
  env: Env,
  option: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
  ...aliases: string[]
): number {
  const raw = read(env, option, ...aliases);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    warnings.push(`${option}=${JSON.stringify(raw)} is not a number in [${min}, ${max}]; using ${fallback}.`);
    return fallback;
  }
  return value;
}

/** Where session files and the decision log live. */
export function resolveDataDir(env: Env = process.env, scriptPath: string | undefined = process.argv[1]): string {
  const explicit = env.CLAUDE_PLUGIN_DATA?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  const jev = env.JEV_HOOKS_DATA_DIR?.trim();
  if (jev !== undefined && jev !== "") return jev;
  const dataRoot = join(env.HOME?.trim() || homedir(), ".claude", "plugins", "data");
  return join(dataRoot, installIdFromScriptPath(scriptPath) ?? "jev");
}

/**
 * CLAUDE_PLUGIN_DATA is exported to hook processes only. A /jev:* command runs
 * through the Bash tool without it, and must still read the directory the hooks
 * write to. An installed plugin runs from
 * `<…>/plugins/cache/<marketplace>/<plugin>/<version>/dist/hook.mjs`, and Claude
 * Code names the data directory `<plugin>-<marketplace>` with characters
 * outside [A-Za-z0-9_-] replaced by `-`.
 */
export function installIdFromScriptPath(scriptPath: string | undefined): string | undefined {
  if (scriptPath === undefined) return undefined;
  const parts = scriptPath.replace(/\\/g, "/").split("/");
  const cache = parts.lastIndexOf("cache");
  if (cache < 1 || parts[cache - 1] !== "plugins") return undefined;
  const marketplace = parts[cache + 1];
  const plugin = parts[cache + 2];
  if (!marketplace || !plugin || parts.length < cache + 5) return undefined;
  return `${plugin}@${marketplace}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Read the lint level, migrating an unknown value to the default with a warning. */
function readLint(env: Env, warnings: string[]): LintLevel {
  const raw = read(env, "lint", "JEV_LINT");
  if (raw === undefined) return HOOK_DEFAULTS.lint;
  if ((LINT_LEVELS as readonly string[]).includes(raw)) return raw as LintLevel;
  warnings.push(`lint=${JSON.stringify(raw)} is not one of off|tripwire|advisory; using ${HOOK_DEFAULTS.lint}.`);
  return HOOK_DEFAULTS.lint;
}

export function loadHookConfig(env: Env = process.env): HookConfig {
  const warnings: string[] = [];

  // `gate` replaced `gate_mode` in 0.3.0. An install that still carries the old
  // setting keeps working and is told so by `/jev:status`, rather than silently
  // falling back to the default and changing behaviour under the user.
  const gateRaw = read(env, "gate", "JEV_GATE");
  let gate: GateLevel = HOOK_DEFAULTS.gate;
  if (gateRaw !== undefined) {
    const lowered = gateRaw.toLowerCase();
    if ((GATE_LEVELS as readonly string[]).includes(lowered)) {
      gate = lowered as GateLevel;
    } else {
      warnings.push(`gate=${JSON.stringify(gateRaw)} is not one of ${GATE_LEVELS.join("|")}; using advisory.`);
    }
  } else {
    const legacy = read(env, "gate_mode", "JEV_GATE_MODE");
    if (legacy !== undefined) {
      const mapped = GATE_MODE_MIGRATION[legacy.toLowerCase()];
      if (mapped === undefined) {
        warnings.push(
          `gate_mode=${JSON.stringify(legacy)} is not one of off|standard|strict; using gate=advisory. ` +
            `Set "gate" in /plugin config.`,
        );
      } else {
        gate = mapped;
        warnings.push(`gate_mode is deprecated; read as gate=${mapped}. Set "gate" in /plugin config.`);
      }
    }
  }

  if (read(env, "auto_mode", "JEV_AUTO_MODE") !== undefined) {
    warnings.push("auto_mode is no longer used: every judgment is advisory to Claude and never prompts.");
  }

  const apiKey = read(env, "api_key", "TYPESAFE_API_KEY") ?? null;
  const auto = readNumber(env, "auto_threshold", HOOK_DEFAULTS.autoThreshold, 0, 1, warnings, "JEV_AUTO_THRESHOLD");
  const review = readNumber(
    env,
    "review_threshold",
    Math.min(HOOK_DEFAULTS.reviewThreshold, auto),
    0,
    1,
    warnings,
    "JEV_REVIEW_THRESHOLD",
  );

  return {
    apiKey,
    baseUrl: (read(env, "base_url", "TYPESAFE_BASE_URL") ?? HOOK_DEFAULTS.baseUrl).replace(/\/+$/, ""),
    model: read(env, "model", "JEV_MODEL") ?? HOOK_DEFAULTS.model,
    timeoutMs: readNumber(env, "timeout_ms", HOOK_DEFAULTS.timeoutMs, 100, 10_000, warnings, "JEV_HOOK_TIMEOUT_MS"),
    maxRetries: HOOK_DEFAULTS.maxRetries,
    gate,
    askOnTrip: readBool(env, "ask_on_trip", HOOK_DEFAULTS.askOnTrip, warnings, "JEV_ASK_ON_TRIP"),
    stopCheck: readBool(env, "stop_check", HOOK_DEFAULTS.stopCheck, warnings, "JEV_STOP_CHECK"),
    screenResults: readBool(env, "screen_results", HOOK_DEFAULTS.screenResults, warnings, "JEV_SCREEN_RESULTS"),
    routePrompts: readBool(env, "route_prompts", HOOK_DEFAULTS.routePrompts, warnings, "JEV_ROUTE_PROMPTS"),
    lint: readLint(env, warnings),
    lintConventions: readBool(env, "lint_conventions", HOOK_DEFAULTS.lintConventions, warnings, "JEV_LINT_CONVENTIONS"),
    verifyClaims: readBool(env, "verify_claims", HOOK_DEFAULTS.verifyClaims, warnings, "JEV_VERIFY_CLAIMS"),
    autoThreshold: auto,
    reviewThreshold: Math.min(review, auto),
    confidenceThreshold: readNumber(
      env,
      "confidence_threshold",
      HOOK_DEFAULTS.confidenceThreshold,
      0.5,
      0.99,
      warnings,
      "JEV_CONFIDENCE_THRESHOLD",
    ),
    // Port 0 is allowed and means "ask the OS": the tests use it so they never
    // touch the real port, and nothing in a normal install sets it.
    daemonPort: readNumber(env, "daemon_port", HOOK_DEFAULTS.daemonPort, 0, 65_535, warnings, "JEV_DAEMON_PORT"),
    daemonIdleMs: readNumber(
      env,
      "daemon_idle_ms",
      HOOK_DEFAULTS.daemonIdleMs,
      1000,
      24 * 60 * 60 * 1000,
      warnings,
      "JEV_DAEMON_IDLE_MS",
    ),
    dataDir: resolveDataDir(env),
    disabled: readBool(env, "hooks_disable", false, warnings, "JEV_HOOKS_DISABLE"),
    warnings,
  };
}
