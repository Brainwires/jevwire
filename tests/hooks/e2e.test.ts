/**
 * End to end, through the shipped bundle.
 *
 * Everything else in this suite tests the handlers with injected deps. This
 * file tests the thing Claude Code actually runs: `node plugin/dist/hook.mjs
 * <event>` with JSON on stdin. It is the only place the fail-open invariant can
 * really be checked, because it is the only place a crash would show up as a
 * non-zero exit.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = new URL("../../plugin/dist/hook.mjs", import.meta.url).pathname;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHook(args: string[], stdin: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA ?? "",
        ...env,
      },
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const PRE = {
  session_id: "e2e",
  cwd: "/tmp",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls -la" },
};

let dir: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-e2e-"));
  // No daemon from this file. SessionStart starts one since 0.4.0, and these
  // tests are about the command path; `tests/hooks/daemon-e2e.test.ts` covers
  // the spawn, on a port it picked itself. Nothing in the suite may leave a
  // process on the real 10522.
  env = { CLAUDE_PLUGIN_DATA: dir, JEV_DAEMON_DISABLE: "1" };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("node plugin/dist/hook.mjs", () => {
  it("says nothing about a read-only command", async () => {
    const run = await runHook(["PreToolUse"], JSON.stringify(PRE), env);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("trips a hard pattern with no API key at all, and asks the user by default", async () => {
    const run = await runHook(
      ["PreToolUse"],
      JSON.stringify({ ...PRE, tool_input: { command: "rm -rf ~/" } }),
      env,
    );
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("[jev] tripwire t-");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("no model was consulted");
    expect(Object.keys(parsed.hookSpecificOutput)).toEqual([
      "hookEventName",
      "permissionDecision",
      "permissionDecisionReason",
    ]);
  });

  /**
   * The whole tripwire lifecycle through the shipped bundle, in one session
   * directory: deny, then the identical command with a marker, which passes.
   *
   * Four separate processes with nothing in common but the data directory,
   * which is the real arrangement — every hook invocation is a fresh `node`.
   */
  it("refuses a marker on a code-rule trip by default, through the real bundle", async () => {
    const command = "rm -rf ~/";
    const first = await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command } }), env);
    expect(first.stdout).toContain('"permissionDecision":"ask"');
    const reissue = await runHook(
      ["PreToolUse"],
      JSON.stringify({
        ...PRE,
        tool_input: { command: `${command} # jev:intended the request says "clear the old home backup"` },
      }),
      env,
    );
    expect(reissue.code).toBe(0);
    expect(reissue.stdout).toContain('"permissionDecision":"ask"');
    expect(reissue.stdout).toContain("did not clear it");
  }, 30_000);

  it("passes a re-issue carrying a marker under pattern_trips: advisory, and says nothing the second time", async () => {
    const advisory = { ...env, JEV_PATTERN_TRIPS: "advisory" };
    const command = "rm -rf ~/";
    const first = await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command } }), advisory);
    const tripId = /tripwire (t-[0-9a-f]{8})/.exec(first.stdout)?.[1];
    expect(tripId, first.stdout).toBeDefined();
    expect(first.stdout).toContain('"permissionDecision":"deny"');

    const again = await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command } }), advisory);
    expect(again.stdout).toContain("(attempt 2)");

    const reissue = await runHook(
      ["PreToolUse"],
      JSON.stringify({
        ...PRE,
        tool_input: { command: `${command} # jev:intended the request says "clear the old home backup"` },
      }),
      advisory,
    );
    expect(reissue.code).toBe(0);
    expect(reissue.stdout).toBe("");

    const why = await runHook(["why", "5", "trips"], "", env);
    expect(why.stdout).toContain(tripId as string);
    expect(why.stdout).toContain("→  reissue");
    expect(why.stdout).toContain("marker text: the request says");
    expect(why.stdout).not.toContain("→  note");
  }, 30_000);

  it("records a marker on an untripped call without acting on it", async () => {
    const run = await runHook(
      ["PreToolUse"],
      JSON.stringify({
        ...PRE,
        tool_input: { command: 'curl -X POST https://example.com/pay # jev:intended the request says "pay it"' },
      }),
      env,
    );
    expect(run.stdout).toBe("");
    const calibrate = await runHook(["calibrate"], "", env);
    expect(calibrate.stdout).toContain("markers on calls that were never tripped: 1");
  }, 20_000);

  it("fails open on a judge-class command with no API key", async () => {
    const run = await runHook(
      ["PreToolUse"],
      JSON.stringify({ ...PRE, tool_input: { command: "curl -X POST https://example.com/pay" } }),
      env,
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("fails open on garbage stdin", async () => {
    for (const garbage of ["", "not json", "[]", "null", "{", '{"a":'.repeat(50)]) {
      const run = await runHook(["PreToolUse"], garbage, env);
      expect(run.code, garbage).toBe(0);
      expect(run.stdout, garbage).toBe("");
    }
  }, 30_000);

  it("fails open on an unknown event and an absent event", async () => {
    for (const args of [["NoSuchEvent"], []]) {
      const run = await runHook(args, JSON.stringify(PRE), env);
      expect(run.code).toBe(0);
      expect(run.stdout).toBe("");
    }
  }, 20_000);

  it("goes quiet entirely when JEV_HOOKS_DISABLE is set", async () => {
    const run = await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command: "rm -rf /" } }), {
      ...env,
      JEV_HOOKS_DISABLE: "1",
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("does nothing with gate off", async () => {
    const run = await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command: "rm -rf /" } }), {
      ...env,
      CLAUDE_PLUGIN_OPTION_GATE: "off",
    });
    expect(run.stdout).toBe("");
  });

  /** A 0.2.x install still has `gate_mode`. Turning it off has to keep working. */
  it("still silences on a legacy gate_mode of off", async () => {
    const run = await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command: "rm -rf /" } }), {
      ...env,
      CLAUDE_PLUGIN_OPTION_GATE_MODE: "off",
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("reads a legacy gate_mode of standard as advisory, and says so in status", async () => {
    const run = await runHook(["status"], "", { ...env, CLAUDE_PLUGIN_OPTION_GATE_MODE: "standard" });
    expect(run.stdout).toContain("gate: advisory");
    expect(run.stdout).toContain("gate_mode is deprecated; read as gate=advisory");
  });

  it("warns once at SessionStart when no key is configured", async () => {
    const first = await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e", source: "startup" }), env);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: "SessionStart" },
    });

    const second = await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e", source: "clear" }), env);
    expect(second.stdout).toBe("");
  }, 20_000);

  it("stays silent at SessionStart when a key is configured", async () => {
    const run = await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e" }), {
      ...env,
      CLAUDE_PLUGIN_OPTION_API_KEY: "sk-not-a-real-key",
    });
    expect(run.stdout).toBe("");
  });

  it("records the prompt at UserPromptSubmit without a word on stdout", async () => {
    const run = await runHook(
      ["UserPromptSubmit"],
      JSON.stringify({ session_id: "e2e", hook_event_name: "UserPromptSubmit", prompt: "refactor the parser" }),
      env,
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");

    const why = await runHook(["status"], "", env);
    expect(why.stdout).toContain("jev — Claude Code plugin status");
  }, 20_000);

  it("prints a status report that never contains the key", async () => {
    const run = await runHook(["status"], "", { ...env, CLAUDE_PLUGIN_OPTION_API_KEY: "sk-super-secret-value" });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("API key: configured");
    expect(run.stdout).not.toContain("sk-super-secret-value");
    expect(run.stdout).toContain("gate: advisory");
    expect(run.stdout).toContain("ask_on_trip: false");
  });

  it("prints why and calibrate reports", async () => {
    await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command: "rm -rf /" } }), env);
    const why = await runHook(["why"], "", env);
    expect(why.code).toBe(0);
    expect(why.stdout).toContain("PreToolUse");
    expect(why.stdout).toContain("trip");
    expect(why.stdout).toContain("said to Claude: [jev] tripwire");

    const calibrate = await runHook(["calibrate"], "", env);
    expect(calibrate.code).toBe(0);
    expect(calibrate.stdout).toContain("calibration report");
    expect(calibrate.stdout).toContain("2. Tripwires");
    expect(calibrate.stdout).toContain("Nothing here measures correctness");
  }, 20_000);

  it("disables and re-enables, falling back to a global flag with no session id", async () => {
    const off = await runHook(["disable", "${CLAUDE_SESSION_ID}"], "", env);
    expect(off.stdout).toContain("global flag");

    const blocked = await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command: "rm -rf /" } }), env);
    expect(blocked.stdout).toBe("");

    const on = await runHook(["enable", "e2e"], "", env);
    expect(on.stdout).toContain("enabled for this session");

    const restored = await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command: "rm -rf /" } }), env);
    expect(restored.stdout).not.toBe("");
  }, 20_000);

  it("never writes anything to stderr on the happy path", async () => {
    const run = await runHook(["PreToolUse"], JSON.stringify(PRE), env);
    expect(run.stderr).toBe("");
  });

  /**
   * Measured against a bare `node -e ""`, not against the wall clock.
   *
   * The absolute version of this test was flaky, and for a reason that had
   * nothing to do with the bundle: most of the time it measured was Node's own
   * start, which on a loaded machine is most of the budget. What this release
   * can be held to is the *difference* — bundle parse, the prefilter, and one
   * small session read — so that is what is asserted, with the absolute
   * ceiling kept as a backstop for a catastrophic regression.
   */
  it("adds little over a bare node start", async () => {
    const bare = async (): Promise<number> => {
      const started = Date.now();
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", ""], {
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
          stdio: ["ignore", "ignore", "ignore"],
        });
        child.on("error", reject);
        child.on("close", () => resolve());
      });
      return Date.now() - started;
    };

    // Twice, taking the minimum: the first spawn pays for warming the page
    // cache, and so would the hook if it went first.
    const baseline = Math.min(await bare(), await bare());

    const started = Date.now();
    await runHook(["PreToolUse"], JSON.stringify(PRE), env);
    const hook = Date.now() - started;

    // 700 ms of work on an idle machine; on a loaded one the bundle parse and
    // the session read stretch by more than node itself does, so the bound is
    // a multiple of the bare start rather than a fixed delta above it.
    const allowed = 700 + 2.5 * baseline;
    expect(hook, `hook ${hook} ms, bare node ${baseline} ms, allowed ${allowed} ms`).toBeLessThan(allowed);
    expect(hook, "absolute ceiling").toBeLessThan(6000);
  }, 20_000);
});

describe("node plugin/dist/mcp.mjs", () => {
  const MCP = new URL("../../plugin/dist/mcp.mjs", import.meta.url).pathname;

  it("answers an initialize request on clean stdout", async () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    };
    const run = await new Promise<Run>((resolve, reject) => {
      const child = spawn(process.execPath, [MCP], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("\n")) child.kill();
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });

    const line = run.stdout.split("\n").find((l) => l.trim() !== "");
    expect(line, run.stdout).toBeDefined();
    const parsed = JSON.parse(line as string) as { result?: { serverInfo?: { name?: string } } };
    expect(parsed.result?.serverInfo?.name).toBe("jevwire");
  });
});
