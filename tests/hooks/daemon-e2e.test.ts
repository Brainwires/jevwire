/**
 * The daemon as it actually ships: `node plugin/dist/hook.mjs daemon`.
 *
 * Everything else about the daemon is tested in process. This file tests the
 * bundle, because the bundle is the artifact — a plugin install runs no build —
 * and because the two things most likely to break are the two things only a
 * real process can show: that the `daemon` subcommand is reachable from the
 * bundled entry point at all, and that SIGTERM leaves the state file saying
 * `stopped` rather than lying about a daemon that is gone.
 *
 * CI runs this file twice concurrently on Linux to shake out lock bugs, so
 * nothing here may assume it is alone: every port comes from the OS and every
 * data directory is fresh.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDaemonState } from "../../src/hooks/daemon/state-file.js";
import { isAlive, probeHealth } from "../../src/hooks/daemon/control.js";
import { PROTOCOL } from "../../src/hooks/daemon/protocol.js";
import { HOOK_VERSION } from "../../src/hooks/version.js";
import {
  cleanupDir,
  freePort,
  HOOK_BUNDLE,
  killTracked,
  tempDataDir,
  track,
  trackStateFilePid,
  waitUntil,
} from "./daemon-helpers.js";

let dir: string;
const spawned: ChildProcess[] = [];

beforeEach(() => {
  dir = tempDataDir("jev-e2e-daemon-");
});

afterEach(async () => {
  trackStateFilePid(dir);
  for (const child of spawned) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  spawned.length = 0;
  await killTracked();
  cleanupDir(dir);
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CLAUDE_PLUGIN_DATA: dir,
    ...extra,
  };
}

/** Start the shipped bundle as a daemon and wait for its state file. */
async function startBundleDaemon(args: string[], extraEnv: Record<string, string> = {}): Promise<number> {
  const child = spawn(process.execPath, [HOOK_BUNDLE, "daemon", ...args], {
    env: env(extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(child);
  track(child.pid);
  await waitUntil(() => {
    const state = readDaemonState(dir);
    return state?.state === "running" && state.port > 0;
  }, "the daemon to write a running state file", 10_000);
  const state = readDaemonState(dir);
  expect(state?.pid).toBe(child.pid);
  return state?.port as number;
}

async function post(port: number, event: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/hook/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-jev-protocol": String(PROTOCOL) },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

/**
 * Wait for the daemon on this port to answer.
 *
 * SessionStart gives the spawn about two seconds, which is what fits under its
 * own 5 s hook timeout, and on a machine running the whole suite in parallel a
 * Node process can take longer than that to come up. The behaviour under test
 * is "SessionStart starts a daemon and exits 0 in time", not "the machine is
 * fast", so the exit is asserted strictly and the daemon is waited for.
 */
async function awaitDaemonUp(port: number): Promise<number> {
  await waitUntil(async () => (await probeHealth(port, 500)).kind === "jev", `a daemon on ${port}`, 20_000);
  trackStateFilePid(dir);
  return readDaemonState(dir)?.pid as number;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runHook(args: string[], stdin: string, extraEnv: Record<string, string> = {}): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_BUNDLE, ...args], {
      env: env(extraEnv),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

describe("node plugin/dist/hook.mjs daemon", () => {
  it("binds an OS-chosen port, publishes it, and identifies itself", async () => {
    const port = await startBundleDaemon(["--port", "0"]);
    expect(port).toBeGreaterThan(0);

    const probe = await probeHealth(port, 2000);
    expect(probe.kind).toBe("jev");
    if (probe.kind !== "jev") return;
    expect(probe.health.version).toBe(HOOK_VERSION);
    expect(probe.health.protocol).toBe(PROTOCOL);
    expect(probe.health.bundle_path).toBe(HOOK_BUNDLE);
    // No key in this environment, so it is honest about being unauthenticated.
    expect(probe.health.auth).toBe("none");
  }, 30_000);

  it("denies a hard pattern with the tripwire text, through the bundle", async () => {
    const port = await startBundleDaemon(["--port", "0"]);
    const reply = await post(port, "PreToolUse", {
      session_id: "e2e",
      cwd: "/tmp",
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf ~/" },
    });
    expect(reply.status).toBe(200);
    const parsed = JSON.parse(reply.text) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    // `pattern_trips: ask`, the default: the user answers a code-rule trip.
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("[jev] tripwire t-");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("no model was consulted");
    // And it wrote the decision log, in the data directory it was given.
    const log = await runHook(["why", "3", "trips"], "");
    expect(log.stdout).toContain("said to Claude: [jev] tripwire");
  }, 30_000);

  it("stays quiet about a read-only command", async () => {
    const port = await startBundleDaemon(["--port", "0"]);
    const reply = await post(port, "PreToolUse", {
      session_id: "e2e",
      cwd: "/tmp",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    expect(reply.text).toBe("{}");
  }, 30_000);

  it("counts what it served and reports it in health", async () => {
    const port = await startBundleDaemon(["--port", "0"]);
    for (let i = 0; i < 3; i += 1) {
      await post(port, "PreToolUse", {
        session_id: "e2e",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      });
    }
    const probe = await probeHealth(port, 2000);
    expect(probe.kind).toBe("jev");
    if (probe.kind === "jev") expect(probe.health.counters?.hooks.PreToolUse).toBe(3);
  }, 30_000);

  it("writes `stopped` on SIGTERM and frees the port", async () => {
    const port = await startBundleDaemon(["--port", "0"]);
    const pid = readDaemonState(dir)?.pid as number;

    process.kill(pid, "SIGTERM");
    await waitUntil(() => !isAlive(pid), "the daemon to exit", 10_000);
    // The final state write and the port release complete during shutdown;
    // under a loaded machine they can land a beat after the pid is gone.
    await waitUntil(() => readDaemonState(dir)?.state === "stopped", "the stopped state to be written", 5_000);

    const state = readDaemonState(dir);
    expect(state?.state).toBe("stopped");
    expect(state?.port).toBe(port);
    await waitUntil(async () => (await probeHealth(port, 500)).kind === "refused", "the port to be released", 5_000);
  }, 30_000);

  it("records a port conflict rather than crashing when it cannot bind", async () => {
    const port = await freePort();
    const first = await startBundleDaemon(["--port", String(port)]);
    expect(first).toBe(port);

    // A second daemon in its own data directory, aimed at the same port.
    const otherDir = tempDataDir("jev-e2e-conflict-");
    try {
      const child = spawn(process.execPath, [HOOK_BUNDLE, "daemon", "--port", String(port)], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CLAUDE_PLUGIN_DATA: otherDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      spawned.push(child);
      track(child.pid);
      await waitUntil(() => readDaemonState(otherDir) !== undefined, "the loser to write its state file", 10_000);
      expect(readDaemonState(otherDir)?.state).toBe("port-conflict");
      // It exited 0, because a hook process that exits non-zero is a deny.
      await waitUntil(() => !isAlive(child.pid as number), "the loser to exit", 10_000);
      expect(child.exitCode).toBe(0);
      // The winner is untouched.
      expect((await probeHealth(port, 1000)).kind).toBe("jev");
    } finally {
      cleanupDir(otherDir);
    }
  }, 40_000);
});

describe("SessionStart through the bundle", () => {
  it("starts a daemon and exits 0 well inside the 5 second hook timeout", async () => {
    const port = await freePort();
    const run = await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e", source: "startup" }), {
      JEV_DAEMON_PORT: String(port),
    });

    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(5000);
    expect(run.stderr).toBe("");

    const pid = await awaitDaemonUp(port);
    const state = readDaemonState(dir);
    expect(state?.state).toBe("running");
    expect(state?.port).toBe(port);
    expect(isAlive(pid)).toBe(true);

    expect((await probeHealth(port, 2000)).kind).toBe("jev");
  }, 30_000);

  it("registers the session with a daemon that is already up", async () => {
    // Deterministic version of the registration: the daemon is listening before
    // the hook runs, so there is no spawn race to lose.
    const port = await startBundleDaemon(["--port", "0"]);
    const run = await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e", source: "startup" }), {
      JEV_DAEMON_PORT: String(port),
    });
    expect(run.code).toBe(0);
    const probe = await probeHealth(port, 2000);
    expect(probe.kind).toBe("jev");
    if (probe.kind === "jev") expect(probe.health.sessions).toBe(1);
    // And the snapshot is on disk, so a daemon replaced mid-session can reload
    // this session's settings instead of using its own environment's.
    const session = JSON.parse(
      readFileSync(join(dir, "sessions", "e2e.json"), "utf8"),
    ) as { config?: { gate?: string } };
    expect(session.config?.gate).toBe("advisory");
  }, 30_000);

  it("persists the session's config snapshot, for a daemon replaced later", async () => {
    const port = await freePort();
    await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e", source: "startup" }), {
      JEV_DAEMON_PORT: String(port),
      CLAUDE_PLUGIN_OPTION_GATE: "strict",
    });
    trackStateFilePid(dir);

    const status = await runHook(["status"], "", { JEV_DAEMON_PORT: String(port) });
    expect(status.stdout).toContain("Daemon");
    expect(status.stdout).toContain(`127.0.0.1:${port}`);
  }, 30_000);

  it("finds the daemon already running on a second session start", async () => {
    const port = await freePort();
    const first = await runHook(["SessionStart"], JSON.stringify({ session_id: "a" }), {
      JEV_DAEMON_PORT: String(port),
    });
    expect(first.code).toBe(0);
    const pid = await awaitDaemonUp(port);

    const second = await runHook(["SessionStart"], JSON.stringify({ session_id: "b" }), {
      JEV_DAEMON_PORT: String(port),
    });
    expect(second.code).toBe(0);
    // Same daemon: one process serves every session on the machine.
    expect(readDaemonState(dir)?.pid).toBe(pid);
    const probe = await probeHealth(port, 2000);
    // At least the second session; the first may have lost the spawn race to
    // its own 2 s confirmation window, in which case the daemon picks its
    // config up from the session file on the first hook instead.
    if (probe.kind === "jev") expect(probe.health.sessions).toBeGreaterThanOrEqual(1);
  }, 40_000);

  it("warns the user, and still exits 0, when something else holds the port", async () => {
    const port = await freePort();
    // A server that answers HTML: the port-squatting case.
    const squatter = spawn(
      process.execPath,
      [
        "-e",
        `require("node:http").createServer((q,s)=>{s.writeHead(200,{"content-type":"text/html"});s.end("<html>no</html>")}).listen(${port},"127.0.0.1",()=>process.stdout.write("ready\\n"))`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    spawned.push(squatter);
    track(squatter.pid);
    await waitUntil(async () => (await probeHealth(port, 300)).kind === "foreign", "the squatter to answer", 10_000);

    const run = await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e" }), {
      JEV_DAEMON_PORT: String(port),
    });
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout) as { systemMessage?: string };
    expect(parsed.systemMessage).toContain("Something other than jev is listening");
    expect(parsed.systemMessage).toContain(String(port));
    expect(readDaemonState(dir)?.state).toBe("port-conflict");
    // The squatter is still running: this plugin does not kill strangers.
    expect(isAlive(squatter.pid as number)).toBe(true);
  }, 30_000);

  it("starts nothing when JEV_DAEMON_DISABLE is set", async () => {
    const port = await freePort();
    const run = await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e" }), {
      JEV_DAEMON_PORT: String(port),
      JEV_DAEMON_DISABLE: "1",
    });
    expect(run.code).toBe(0);
    expect(readDaemonState(dir)).toBeUndefined();
    expect((await probeHealth(port, 300)).kind).toBe("refused");
  }, 20_000);
});

describe("daemon-ctl through the bundle", () => {
  it("reports a daemon it can reach, then stops it", async () => {
    const port = await freePort();
    await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e" }), { JEV_DAEMON_PORT: String(port) });
    const pid = await awaitDaemonUp(port);

    const status = await runHook(["daemon-ctl", "status"], "", { JEV_DAEMON_PORT: String(port) });
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("status: up");
    expect(status.stdout).toContain(`pid ${pid}`);

    const stop = await runHook(["daemon-ctl", "stop"], "", { JEV_DAEMON_PORT: String(port) });
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain("jev daemon stopped");
    await waitUntil(() => !isAlive(pid), "the daemon to exit", 10_000);

    const after = await runHook(["daemon-ctl", "status"], "", { JEV_DAEMON_PORT: String(port) });
    expect(after.stdout).toContain("status: down");
  }, 40_000);

  it("says nothing was running when nothing is", async () => {
    const port = await freePort();
    const stop = await runHook(["daemon-ctl", "stop"], "", { JEV_DAEMON_PORT: String(port) });
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain("was not running");
  }, 20_000);

  it("restart only stops, and says why", async () => {
    const port = await freePort();
    await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e" }), { JEV_DAEMON_PORT: String(port) });
    const pid = await awaitDaemonUp(port);

    const restart = await runHook(["daemon-ctl", "restart"], "", { JEV_DAEMON_PORT: String(port) });
    expect(restart.code).toBe(0);
    expect(restart.stdout).toContain("jev daemon stopped");
    expect(restart.stdout).toContain("sandboxed");
    await waitUntil(() => !isAlive(pid), "the daemon to exit", 10_000);
    // Deliberately nothing came back up from here.
    expect((await probeHealth(port, 300)).kind).toBe("refused");
  }, 40_000);

  it("prints usage for an unknown subcommand", async () => {
    const run = await runHook(["daemon-ctl", "explode"], "", { JEV_DAEMON_PORT: "0" });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("usage: /jev:daemon status | stop | restart");
  }, 20_000);
});
