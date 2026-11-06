/**
 * The hook runtime. One process, one event, one JSON object on stdout — or
 * nothing at all, which is the common case.
 *
 * Three rules shape this file:
 *
 * 1. **Fail open, and say so.** Every failure — no key, a timeout, a network
 *    error, malformed stdin, a bug in a handler — lets the call through: exit 0,
 *    never a deny, never a prompt. The error goes to the decision log. A
 *    permission hook that breaks someone's session because an API was down is
 *    worse than no hook. What it is not any more is silent: a tool-gate
 *    judgment that errors or times out adds a rate-limited `systemMessage`
 *    saying the call went through unjudged (see `handlePreToolUse`). Nothing
 *    is promised for the no-daemon case — Claude Code drops a refused http
 *    hook without a word, and SessionStart is where daemon trouble is reported.
 * 2. **stdout is protocol.** Nothing else is ever written there.
 * 3. **Bounded time.** The handler races a hard wall-clock timer well inside
 *    the 5-second `timeout` declared in hooks.json, so Claude Code never has to
 *    kill us.
 *
 * It must also stay small: no MCP SDK, no zod. Everything it imports is either
 * a node builtin or part of the dependency-free decision core.
 *
 * Since 0.4.0 the same binary has three other jobs: `daemon` runs the loopback
 * server the `type: "http"` hooks talk to, `daemon-ctl` is what `/jev:daemon`
 * calls, and `SessionStart` starts or replaces the daemon after running its own
 * handler. Everything about that is still fail-open: SessionStart exits 0 with
 * or without a daemon, and a session with no daemon is a session with no hooks,
 * not a broken one.
 */

import { JevDecisionModel } from "../jev/client.js";
import type { DecisionModel } from "../decision/types.js";
import { loadHookConfig, type HookConfig } from "./config.js";
import { expectedKeysFrom, keyFingerprint } from "./daemon/auth.js";
import { ensureDaemon, probeHealth, replaceDaemon, stopDaemon, type EnsureResult } from "./daemon/control.js";
import { runDaemon } from "./daemon/main.js";
import { PROTOCOL } from "./daemon/protocol.js";
import { sessionConfigOf } from "./daemon/registry.js";
import { HANDLERS, runEvent, withDeadline, WALL_CLOCK_MS } from "./dispatch.js";
import { calibrateReport, daemonReport, daemonView, statusReport, whyReport, type WhyFilter } from "./report.js";
import { Store } from "./store.js";
import type { Deps, HookOutput } from "./types.js";

export { HANDLERS, runEvent, WALL_CLOCK_MS } from "./dispatch.js";

/**
 * Budget for the daemon half of SessionStart.
 *
 * SessionStart's `timeout` is 5 s. The handler itself makes no network call, so
 * nearly all of it is available — but a spawn plus a health wait plus a session
 * registration should not get anywhere near it, and if it does, exiting without
 * a daemon beats being killed.
 */
export const SESSION_START_DAEMON_MS = 3500;

/** `POST /v1/session/start` is one small loopback request. Give it little. */
const SESSION_POST_MS = 700;

export function buildDeps(config: HookConfig, model?: DecisionModel | null): Deps {
  const resolved =
    model !== undefined
      ? model
      : config.apiKey === null
        ? null
        : new JevDecisionModel({
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            model: config.model,
            timeoutMs: config.timeoutMs,
            maxRetries: config.maxRetries,
          });
  return { model: resolved, config, store: new Store(config.dataDir), now: () => Date.now() };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The `/jev:*` commands. A session id that Claude Code failed to substitute
 * arrives as the literal placeholder; treat it as absent and fall back to the
 * global flag, which is what `/jev:off` promises in that case.
 */
function sessionArgument(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("${") || trimmed.toLowerCase() === "unknown") return null;
  return trimmed;
}

async function runCommand(command: string, args: string[], deps: Deps): Promise<string | undefined> {
  switch (command) {
    case "status":
      return statusReport(deps.config, deps.store, deps.now(), await daemonView(deps.config, deps.now()));
    case "why": {
      // `why`, `why 5`, `why trips`, `why 5 trips`: the count and the filter
      // are recognized by shape, so the order the user types them in does not
      // matter and a typo falls back to the default rather than to nothing.
      const numeric = args.map((arg) => Number(arg)).find((value) => Number.isFinite(value) && value > 0);
      const filter = args.map((arg) => arg.toLowerCase()).find((arg): arg is WhyFilter =>
        arg === "notes" || arg === "trips" || arg === "all",
      );
      return whyReport(deps.store, numeric === undefined ? 3 : Math.floor(numeric), filter ?? "all");
    }
    case "calibrate":
      return calibrateReport(deps.config, deps.store);
    case "disable":
    case "enable": {
      const disabled = command === "disable";
      const result = deps.store.setDisabled(sessionArgument(args[0]), disabled);
      const scope = result.scope === "session" ? "this session" : "all sessions (global flag)";
      return `jev hooks ${disabled ? "disabled" : "enabled"} for ${scope}.\n  ${result.path}`;
    }
    default:
      return undefined;
  }
}

const COMMANDS = new Set(["status", "why", "calibrate", "disable", "enable"]);

/**
 * `/jev:daemon <status|stop|restart>`.
 *
 * `restart` only stops, on purpose. These run through the Bash tool, whose
 * process may be sandboxed, and a daemon that inherited that sandbox would be a
 * daemon that cannot read the data directory or reach the network. The MCP
 * watchdog picks it up within ten seconds, and the next SessionStart certainly
 * does.
 */
async function runDaemonCtl(action: string, config: HookConfig, now: number): Promise<string> {
  const port = config.daemonPort;
  switch (action) {
    case "status":
      return daemonReport(config, await daemonView(config, now), now).join("\n");
    case "stop": {
      const result = await stopDaemon(config.dataDir, port);
      const after = daemonReport(config, await daemonView(config, now), now).join("\n");
      const headline =
        result === "stopped"
          ? `jev daemon stopped (port ${port}).`
          : result === "not-running"
            ? `jev daemon was not running on port ${port}.`
            : `jev daemon on port ${port} did not stop; its pid is still alive.`;
      return `${headline}\n\n${after}`;
    }
    case "restart": {
      const result = await stopDaemon(config.dataDir, port);
      return (
        `${result === "stopped" ? "jev daemon stopped" : `jev daemon was not running on port ${port}`}.\n` +
        "A fresh one is not started from here: this command runs through the Bash tool, whose process may be\n" +
        "sandboxed, and a daemon that inherited that sandbox could not read the data directory. The MCP\n" +
        "server's watchdog starts a replacement within ten seconds, and the next session start does too.\n" +
        "Nothing is broken in the meantime: with no daemon the http hooks fail open and say nothing."
      );
    }
    default:
      return "usage: /jev:daemon status | stop | restart";
  }
}

/** What the user is told when the daemon could not be made to run. */
function daemonSystemMessage(result: EnsureResult, port: number): string | undefined {
  if (result === "conflict") {
    return (
      `[jev] Something other than jev is listening on 127.0.0.1:${port}, so jev's hooks are inactive for this ` +
      `session — they post to that port and whatever is there is not answering as jev. Nothing is blocked and ` +
      `nothing is being sent to it beyond the hook payload. Free the port, or set the jev daemon's port with ` +
      `JEV_DAEMON_PORT and update the plugin's hooks.json URL to match, then restart the session.`
    );
  }
  if (result === "failed") {
    // Deliberately not "the daemon failed": SessionStart gives it about two
    // seconds, which is what fits under the hook's own timeout, and a loaded
    // machine can take longer than that to start a Node process. The daemon may
    // well be up already. The MCP server's watchdog checks every ten seconds.
    return (
      `[jev] jev's judgment daemon did not confirm it was listening on 127.0.0.1:${port} within the time ` +
      `SessionStart has to wait, so the hooks that post to it may be inactive at the start of this session. ` +
      `They fail open: nothing is blocked either way. It may simply have been slow to start — /jev:daemon ` +
      `status says whether it is up now, and the daemon's own output is in daemon.log next to the session files.`
    );
  }
  return undefined;
}

/**
 * The bundle to run as the daemon, or `undefined` when there is not one.
 *
 * Under `tsx` (the dev and test path) `argv[1]` is a TypeScript file that plain
 * `node` cannot execute, so the daemon is simply not started; the tests that
 * want one spawn it explicitly. `JEV_DAEMON_DISABLE=1` turns it off everywhere,
 * which is how the rest of the suite keeps its hands off the real port.
 */
export function daemonBundlePath(env: NodeJS.ProcessEnv = process.env, scriptPath = process.argv[1]): string | undefined {
  if ((env.JEV_DAEMON_DISABLE ?? "").trim() === "1") return undefined;
  if (scriptPath === undefined || scriptPath === "") return undefined;
  if (!scriptPath.endsWith(".mjs") && !scriptPath.endsWith(".js") && !scriptPath.endsWith(".cjs")) return undefined;
  return scriptPath;
}

/** `POST` a small JSON body to the daemon. Resolves to the status and body. */
async function postJson(
  port: number,
  path: string,
  body: unknown,
  apiKey: string | null,
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | undefined> {
  const { request } = await import("node:http");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { status: number; body: unknown } | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const payload = Buffer.from(JSON.stringify(body ?? {}), "utf8");
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          "content-length": payload.byteLength,
          "x-jev-protocol": String(PROTOCOL),
          ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          } catch {
            parsed = undefined;
          }
          finish({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on("error", () => finish(undefined));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(undefined);
    }, timeoutMs + 50);
    req.on("timeout", () => {
      req.destroy();
      finish(undefined);
    });
    req.on("error", () => finish(undefined));
    req.end(payload);
  });
}

/**
 * SessionStart's second half: make sure the daemon is up, then tell it about
 * this session.
 *
 * Order matters. `ensureDaemon` first, because there is nothing to register
 * with otherwise; the registration second, because a daemon that does not know
 * this session's settings would judge it with its own. A 401 is not reported as
 * an authorization problem — it means the daemon holding the port was
 * configured with a different key, which makes it a stale daemon, so it gets
 * replaced and the registration is tried once more.
 */
async function startDaemonForSession(
  config: HookConfig,
  sessionId: string,
  bundlePath: string,
): Promise<{ result: EnsureResult; systemMessage?: string }> {
  // Fingerprints of every key this environment holds, so `ensureDaemon`
  // replaces a running daemon that is missing one: a key changed since it
  // started takes effect at the next session start.
  const options = {
    dataDir: config.dataDir,
    port: config.daemonPort,
    bundlePath,
    env: process.env,
    keyFingerprints: expectedKeysFrom(process.env).map(keyFingerprint),
  };
  let result = await ensureDaemon(options);
  if (result === "conflict") {
    const message = daemonSystemMessage(result, config.daemonPort);
    return { result, ...(message !== undefined ? { systemMessage: message } : {}) };
  }

  // Register even after a `failed`, which mostly means "did not confirm inside
  // the budget" rather than "will never start". A daemon that came up half a
  // second late still wants to know about this session, and the attempt costs
  // one refused loopback connection if it really is not there.
  const body = {
    session_id: sessionId,
    data_dir: config.dataDir,
    config: sessionConfigOf(config),
    protocol: PROTOCOL,
  };
  let reply = await postJson(config.daemonPort, "/v1/session/start", body, config.apiKey, SESSION_POST_MS);
  if (reply?.status === 401) {
    result = await replaceDaemon(options);
    if (result === "conflict" || result === "failed") {
      const message = daemonSystemMessage(result, config.daemonPort);
      return { result, ...(message !== undefined ? { systemMessage: message } : {}) };
    }
    reply = await postJson(config.daemonPort, "/v1/session/start", body, config.apiKey, SESSION_POST_MS);
  }

  // Only now is a `failed` worth telling the user about: the registration is
  // the second, later chance to find the daemon, and it just missed too.
  if (result === "failed" && reply === undefined) {
    const message = daemonSystemMessage("failed", config.daemonPort);
    return { result, ...(message !== undefined ? { systemMessage: message } : {}) };
  }

  // The daemon may have something to say. Normally it does not.
  const replyBody = reply?.body;
  if (typeof replyBody === "object" && replyBody !== null) {
    const message = (replyBody as { systemMessage?: unknown }).systemMessage;
    if (typeof message === "string" && message.trim() !== "") return { result, systemMessage: message };
  }
  return { result };
}

/**
 * The `UserPromptSubmit` command fallback.
 *
 * `hooks.json` gives UserPromptSubmit both an http entry and this one, so the
 * very first prompt of a session is covered even if the daemon is still coming
 * up. Both would otherwise record the prompt twice, so this probes the port
 * first — a couple of milliseconds in-process, not the 70–80 ms a shell probe
 * costs — and says nothing at all if the daemon answered. `nextPrompts` drops
 * an identical consecutive prompt, so even a lost race is harmless.
 */
async function shouldRunFallback(config: HookConfig): Promise<boolean> {
  const probe = await probeHealth(config.daemonPort, 150);
  return probe.kind !== "jev";
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const event = argv[2] ?? "";

  // The daemon parses its own configuration: it is not serving one session's
  // hook, it is about to serve everybody's.
  if (event === "daemon") {
    await runDaemon(argv.slice(3), process.env);
    return;
  }

  const config = loadHookConfig();

  if (event === "daemon-ctl") {
    const text = await runDaemonCtl(argv[3] ?? "status", config, Date.now());
    process.stdout.write(`${text}\n`);
    return;
  }

  if (config.disabled) return;

  const deps = buildDeps(config);

  if (COMMANDS.has(event)) {
    // Reports are for a person, so they may write plain text and take their
    // time; they still must not throw.
    const text = await runCommand(event, argv.slice(3), deps);
    if (text !== undefined) process.stdout.write(`${text}\n`);
    return;
  }

  if (!(event in HANDLERS)) return;

  const fallback = argv.includes("--fallback");
  if (fallback && !(await shouldRunFallback(config))) return;

  const raw = await readStdin();
  const output = await withDeadline((async () => runEvent(event, raw, deps))(), WALL_CLOCK_MS);

  // SessionStart is the only event that also runs the daemon's control plane.
  // It happens after the handler so that a slow or failing spawn can never
  // delay or suppress the one thing SessionStart exists to say.
  let merged: HookOutput | undefined = output;
  if (event === "SessionStart") {
    const bundlePath = daemonBundlePath();
    if (bundlePath !== undefined) {
      let sessionId = "unknown";
      try {
        const parsed = JSON.parse(raw) as { session_id?: unknown };
        if (typeof parsed.session_id === "string" && parsed.session_id.trim() !== "") sessionId = parsed.session_id;
      } catch {
        // No session id: the daemon will fall back to its own config.
      }
      const started = await withDeadline(
        startDaemonForSession(config, sessionId, bundlePath),
        SESSION_START_DAEMON_MS,
      );
      if (started?.systemMessage !== undefined) {
        merged = {
          ...(merged ?? {}),
          systemMessage:
            merged?.systemMessage === undefined
              ? started.systemMessage
              : `${merged.systemMessage}\n${started.systemMessage}`,
        };
      }
      // Keep the snapshot on disk too, so a daemon replaced later in this
      // session can reload this session's settings instead of using its own.
      try {
        deps.store.updateSession(sessionId, (state) => ({ ...state, config: sessionConfigOf(config) }), deps.now());
      } catch {
        // Best effort, like everything else this store does.
      }
    }
  }

  if (merged !== undefined) process.stdout.write(JSON.stringify(merged));
}
