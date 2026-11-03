/**
 * The MCP server's ten-second look at the daemon.
 *
 * `SessionStart` starts the daemon, which covers the normal case. This covers
 * the rest: the daemon was killed mid-session, it exited on its idle timer, it
 * crashed, or the user ran `/jev:daemon restart` — which deliberately only
 * stops, because it runs through the Bash tool and a daemon spawned from a
 * sandboxed process would inherit that sandbox. Something has to start the
 * replacement, and the MCP server is the one process in the picture that is
 * already long-lived, already unsandboxed, and already carries the plugin's
 * configuration in its environment.
 *
 * Two rules, both about not being a nuisance:
 *
 * - **Never block the MCP loop.** The interval is `unref`'d, so it cannot keep
 *   the process alive on its own, and one run never overlaps the next. Every
 *   error is swallowed and counted; nothing here is worth failing a tool call
 *   over, and stderr in an MCP server is the user's transcript.
 * - **Do nothing unless asked.** It is off unless the manifest sets
 *   `JEV_PLUGIN_DAEMON=1`, so `npx @brainwires/jevwire` as a plain MCP server — no plugin,
 *   no hooks — never starts a daemon that would have no hooks to serve.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./hooks/config.js";
import { loadHookConfig } from "./hooks/config.js";
import { ensureDaemon, type EnsureResult } from "./hooks/daemon/control.js";

export const WATCHDOG_INTERVAL_MS = 10_000;

export interface WatchdogStats {
  runs: number;
  failures: number;
  last: EnsureResult | undefined;
}

export interface WatchdogHandle {
  stop(): void;
  stats(): WatchdogStats;
  /** Run one pass now. Exported for the tests; the interval calls it too. */
  tick(): Promise<void>;
}

/**
 * Where the plugin's `hook.mjs` is.
 *
 * `JEV_PLUGIN_ROOT` is set by the manifest from `${CLAUDE_PLUGIN_ROOT}`;
 * `CLAUDE_PLUGIN_ROOT` itself is also exported to MCP subprocesses, so either
 * will do. A value that still contains `${` is an unsubstituted placeholder —
 * the same failure mode `loadConfig` already guards against for the API key —
 * and is ignored rather than turned into a path that cannot exist.
 */
export function resolveBundlePath(env: Env): string | undefined {
  for (const raw of [env.JEV_PLUGIN_ROOT, env.CLAUDE_PLUGIN_ROOT]) {
    const root = raw?.trim();
    if (root === undefined || root === "" || root.includes("${")) continue;
    const candidate = join(root, "dist", "hook.mjs");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Start watching, or return `undefined` with a reason if there is nothing to
 * watch. The reason is for the server's own stderr line at startup; the
 * watchdog itself says nothing ever again.
 */
export function startDaemonWatchdog(
  env: Env = process.env,
  intervalMs: number = WATCHDOG_INTERVAL_MS,
  /** Passed straight to `ensureDaemon`. Raised only by the tests. */
  waitMs?: number,
): WatchdogHandle | undefined {
  if ((env.JEV_PLUGIN_DAEMON ?? "").trim() !== "1") return undefined;
  const bundlePath = resolveBundlePath(env);
  if (bundlePath === undefined) return undefined;

  const config = loadHookConfig(env);
  const stats: WatchdogStats = { runs: 0, failures: 0, last: undefined };
  let inFlight = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (inFlight || stopped) return;
    inFlight = true;
    stats.runs += 1;
    try {
      const result = await ensureDaemon({
        dataDir: config.dataDir,
        port: config.daemonPort,
        bundlePath,
        env,
        ...(waitMs !== undefined ? { waitMs } : {}),
      });
      stats.last = result;
      if (result === "failed" || result === "conflict") stats.failures += 1;
    } catch {
      // `ensureDaemon` does not throw, but a watchdog that could take the MCP
      // server down with it would be worse than no watchdog.
      stats.failures += 1;
      stats.last = "failed";
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // The MCP server's stdio transport is what keeps the process alive. This must
  // never be the reason it stays up, or `npx @brainwires/jevwire | head` would hang.
  timer.unref();

  // The first pass runs immediately rather than after ten seconds: if the
  // daemon is already down when the server starts, waiting is pointless.
  void tick();

  return {
    stop: (): void => {
      stopped = true;
      clearInterval(timer);
    },
    stats: (): WatchdogStats => ({ ...stats }),
    tick,
  };
}
