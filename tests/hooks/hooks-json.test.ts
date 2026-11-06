/**
 * What `plugin/hooks/hooks.json` actually declares.
 *
 * This file is the one part of the plugin nothing else validates: a typo in a
 * URL, an event with no handler behind it, or a header referencing a variable
 * that is not in `allowedEnvVars` all install cleanly and then do nothing. The
 * failure mode is a user believing they have a gate. So the manifest is checked
 * against the code it points at.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, PROTOCOL } from "../../src/hooks/daemon/server.js";
import { HANDLERS } from "../../src/hooks/main.js";

interface HookEntry {
  type: string;
  url?: string;
  command?: string;
  args?: string[];
  timeout?: number;
  statusMessage?: string;
  async?: boolean;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
}

interface Matcher {
  matcher?: string;
  hooks: HookEntry[];
}

const root = new URL("../../", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(`${root}plugin/hooks/hooks.json`, "utf8")) as {
  description: string;
  hooks: Record<string, Matcher[]>;
};

const groups = Object.entries(manifest.hooks);
const entries = groups.flatMap(([event, matchers]) =>
  matchers.flatMap((matcher) => matcher.hooks.map((hook) => ({ event, hook }))),
);
const httpEntries = entries.filter((entry) => entry.hook.type === "http");
const commandEntries = entries.filter((entry) => entry.hook.type === "command");

describe("hooks.json shape", () => {
  it("declares only hook types Claude Code supports", () => {
    for (const { hook } of entries) expect(["command", "http"]).toContain(hook.type);
  });

  it("gives every entry a timeout inside the plugin's own wall clock", () => {
    for (const { event, hook } of entries) {
      expect(hook.timeout, `${event} ${hook.type}`).toBeDefined();
      expect(hook.timeout, `${event} ${hook.type}`).toBeLessThanOrEqual(5);
      expect(hook.timeout, `${event} ${hook.type}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("gives SessionEnd the short timeout it has to live inside", () => {
    // SessionEnd hooks share a 1.5 s budget across every plugin, and a plugin's
    // own timeout does not raise it. 2 is the smallest honest number.
    const sessionEnd = entries.filter((entry) => entry.event === "SessionEnd");
    expect(sessionEnd).toHaveLength(1);
    expect(sessionEnd[0]?.hook.timeout).toBe(2);
  });

  it("never declares `async` on an http entry", () => {
    // Claude Code honours `async` on command hooks only. The `Approval` entry
    // does not need it: the daemon answers `{}` first and books afterwards.
    for (const { event, hook } of httpEntries) expect(hook.async, event).toBeUndefined();
  });
});

describe("the http entries", () => {
  it("all post to the loopback daemon on the default port", () => {
    expect(httpEntries.length).toBeGreaterThan(0);
    for (const { event, hook } of httpEntries) {
      expect(hook.url, event).toBe(
        `http://127.0.0.1:${DEFAULT_PORT}/v1/hook/${hook.url?.split("/v1/hook/")[1] ?? ""}`,
      );
      expect(hook.url, event).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/hook\/[A-Za-z]+$/);
    }
  });

  it("name an event that has a handler behind it", () => {
    for (const { event, hook } of httpEntries) {
      const routed = (hook.url as string).split("/v1/hook/")[1] as string;
      expect(Object.keys(HANDLERS), `${event} → ${routed}`).toContain(routed);
    }
  });

  it("send both credential headers and the protocol version", () => {
    for (const { event, hook } of httpEntries) {
      expect(hook.headers?.Authorization, event).toBe("Bearer $CLAUDE_PLUGIN_OPTION_API_KEY");
      expect(hook.headers?.["X-Jev-Env-Key"], event).toBe("$TYPESAFE_API_KEY");
      expect(hook.headers?.["X-Jev-Protocol"], event).toBe(String(PROTOCOL));
    }
  });

  it("reference only variables they also allow", () => {
    // An unlisted variable interpolates to the empty string, which would send a
    // bare `Bearer ` and look to the daemon like no credential at all.
    for (const { event, hook } of httpEntries) {
      const allowed = new Set(hook.allowedEnvVars ?? []);
      for (const value of Object.values(hook.headers ?? {})) {
        for (const match of value.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)) {
          expect(allowed, `${event} references ${match[1] as string}`).toContain(match[1] as string);
        }
      }
    }
  });

  it("allow exactly the two credential variables and nothing else", () => {
    for (const { event, hook } of httpEntries) {
      expect(hook.allowedEnvVars, event).toEqual(["CLAUDE_PLUGIN_OPTION_API_KEY", "TYPESAFE_API_KEY"]);
    }
  });

  it("never carries a `${user_config.*}` placeholder, which http hooks do not substitute", () => {
    expect(readFileSync(`${root}plugin/hooks/hooks.json`, "utf8")).not.toContain("user_config");
  });
});

describe("the command entries", () => {
  it("keep SessionStart a command hook, because it is what starts the daemon", () => {
    const sessionStart = entries.filter((entry) => entry.event === "SessionStart");
    expect(sessionStart).toHaveLength(1);
    expect(sessionStart[0]?.hook.type).toBe("command");
    expect(sessionStart[0]?.hook.command).toContain("dist/hook.mjs");
    expect(sessionStart[0]?.hook.command).toContain("SessionStart");
  });

  it("give UserPromptSubmit both an http entry and a command fallback", () => {
    // Once per prompt, cheap, and it is what protects the very first prompt of a
    // session while the daemon is still coming up.
    const ups = entries.filter((entry) => entry.event === "UserPromptSubmit");
    expect(ups.map((entry) => entry.hook.type)).toEqual(["http", "command"]);
    expect(ups[1]?.hook.command).toContain("--fallback");
  });

  it("are the only ones that reference the plugin root", () => {
    for (const { hook } of commandEntries) expect(hook.command).toContain("${CLAUDE_PLUGIN_ROOT}");
    for (const { hook } of httpEntries) expect(JSON.stringify(hook)).not.toContain("CLAUDE_PLUGIN_ROOT");
  });

  it("exist only on SessionStart and the UserPromptSubmit fallback", () => {
    expect(commandEntries.map((entry) => entry.event).sort()).toEqual(["SessionStart", "UserPromptSubmit"]);
  });
});

describe("coverage", () => {
  it("wires up every event the plugin acts on", () => {
    expect(Object.keys(manifest.hooks).sort()).toEqual([
      "PostToolUse",
      "PostToolUseFailure",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
  });

  /**
   * `Agent` and `Task` are matched but never judged. The hook records the task
   * a subagent was given so the subagent's own calls have something to be in
   * scope *of*; without the matcher the spawn never reaches the plugin and
   * every call inside the subagent is scored against a prompt it never saw.
   */
  it("matches the subagent spawn tools on PreToolUse, so the task can be captured", () => {
    const pre = manifest.hooks.PreToolUse as Matcher[];
    expect(pre).toHaveLength(1);
    expect(pre[0]?.matcher).toBe("Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|Agent|Task|mcp__.*");
    expect(manifest.description).toContain("Agent and Task");
  });

  /**
   * `prefilter()` and the verification ledger both handle `PowerShell` like
   * `Bash`, but until 0.6.6 no matcher sent it, so a PowerShell call was never
   * gated at all (#6). Every matcher that names Bash names PowerShell.
   */
  it("sends PowerShell wherever it sends Bash", () => {
    for (const [event, matchers] of groups) {
      for (const matcher of matchers) {
        const names = (matcher.matcher ?? "").split("|");
        if (names.includes("Bash")) expect(names, `${event} ${matcher.matcher}`).toContain("PowerShell");
      }
    }
    expect((manifest.hooks.PreToolUse as Matcher[])[0]?.matcher).toContain("PowerShell");
  });

  it("routes both post-tool matchers, one to the screen and one to the Approval label", () => {
    const post = manifest.hooks.PostToolUse as Matcher[];
    expect(post).toHaveLength(2);
    // Fetched text goes to the injection screen; edits and commands go to the
    // bookkeeping-only route, which is what closes a tripwire's lifecycle.
    expect(post[0]?.matcher).toBe("WebFetch|WebSearch|mcp__.*");
    expect(post[0]?.hooks[0]?.url).toContain("/v1/hook/PostToolUse");
    expect(post[1]?.matcher).toBe("Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit");
    expect(post[1]?.hooks[0]?.url).toContain("/v1/hook/Approval");
    const failure = manifest.hooks.PostToolUseFailure as Matcher[];
    expect(failure[0]?.matcher).toBe("Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*");
    expect(failure[0]?.hooks[0]?.url).toContain("/v1/hook/Approval");
  });

  it("tells the user in its description what the daemon is and how to turn it off", () => {
    expect(manifest.description).toContain("127.0.0.1:10522");
    expect(manifest.description).toContain("fail open");
    expect(manifest.description).toContain("JEV_HOOKS_DISABLE=1");
    expect(manifest.description).toContain("JEV_DAEMON_DISABLE=1");
  });

  it("promises a notice for a gate error only with the daemon up", () => {
    // Without a daemon, Claude Code drops a refused http hook without a word
    // and nothing here can change that; the description must not claim more.
    expect(manifest.description).toContain("fail open in silence");
    expect(manifest.description).toContain("says so to you at most once every ten minutes");
  });
});
