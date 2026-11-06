/**
 * Hook configuration. It never throws: a typo in a plugin option must not
 * break someone's session.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_DEFAULTS, installIdFromScriptPath, loadHookConfig, resolveDataDir } from "../../src/hooks/config.js";
import { DEFAULT_PORT } from "../../src/hooks/daemon/protocol.js";
import { hookConfigFrom, readSessionConfig, sessionConfigOf } from "../../src/hooks/daemon/registry.js";

describe("loadHookConfig", () => {
  it("uses the documented defaults with an empty environment", () => {
    const config = loadHookConfig({});
    expect(config.apiKey).toBeNull();
    expect(config.gate).toBe("advisory");
    expect(config.askOnTrip).toBe(false);
    expect(config.stopCheck).toBe(true);
    expect(config.screenResults).toBe(true);
    expect(config.routePrompts).toBe(false);
    expect(config.autoThreshold).toBe(0.85);
    expect(config.timeoutMs).toBe(HOOK_DEFAULTS.timeoutMs);
    expect(config.maxRetries).toBe(0);
    expect(config.warnings).toEqual([]);
  });

  /**
   * 0.5.0 pins the model. The hooks' thresholds are tuned against one model's
   * calibration and `/jev:calibrate` replays a log captured from it, so an
   * alias that moves under both is not a default anyone chose.
   */
  it("pins the model version rather than following the alias", () => {
    expect(HOOK_DEFAULTS.model).toBe("jev-1.13.0");
    expect(loadHookConfig({}).model).toBe("jev-1.13.0");
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_MODEL: "jev-latest" }).model).toBe("jev-latest");
    expect(loadHookConfig({ JEV_MODEL: "jev-1.12.0" }).model).toBe("jev-1.12.0");
  });

  it("prefers a plugin option over the env fallback", () => {
    const config = loadHookConfig({
      CLAUDE_PLUGIN_OPTION_API_KEY: "sk-from-plugin",
      TYPESAFE_API_KEY: "sk-from-env",
    });
    expect(config.apiKey).toBe("sk-from-plugin");
  });

  it("falls back to the env var when no plugin option is set", () => {
    expect(loadHookConfig({ TYPESAFE_API_KEY: "sk-from-env" }).apiKey).toBe("sk-from-env");
  });

  it("treats an empty option as unset", () => {
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_API_KEY: "   ", TYPESAFE_API_KEY: "sk-env" }).apiKey).toBe("sk-env");
  });

  it("reads every gate level", () => {
    for (const level of ["off", "advisory", "strict"]) {
      expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE: level }).gate).toBe(level);
    }
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE: "STRICT" }).gate).toBe("strict");
    expect(loadHookConfig({ JEV_GATE: "off" }).gate).toBe("off");
  });

  it("records a warning and keeps going on a bad gate level", () => {
    const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE: "maybe" });
    expect(config.gate).toBe("advisory");
    expect(config.warnings.join(" ")).toContain("gate=");
  });

  it("reads ask_on_trip, the setting that lets a classifier trip prompt a human", () => {
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_ASK_ON_TRIP: "true" }).askOnTrip).toBe(true);
    expect(loadHookConfig({ JEV_ASK_ON_TRIP: "1" }).askOnTrip).toBe(true);
    expect(loadHookConfig({}).askOnTrip).toBe(false);
  });

  /**
   * `pattern_trips` decides who clears a code-rule trip. The default is the
   * secure one, and a value that is not understood falls back to it rather
   * than to the permissive one.
   */
  it("reads pattern_trips, defaulting to ask and warning on a bad value", () => {
    expect(loadHookConfig({}).patternTrips).toBe("ask");
    expect(HOOK_DEFAULTS.patternTrips).toBe("ask");
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_PATTERN_TRIPS: "deny" }).patternTrips).toBe("deny");
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_PATTERN_TRIPS: "Advisory" }).patternTrips).toBe("advisory");
    expect(loadHookConfig({ JEV_PATTERN_TRIPS: "advisory" }).patternTrips).toBe("advisory");
    const bad = loadHookConfig({ JEV_PATTERN_TRIPS: "maybe" });
    expect(bad.patternTrips).toBe("ask");
    expect(bad.warnings.join(" ")).toContain("pattern_trips=");
  });

  it("carries pattern_trips through the daemon's session snapshot, falling back to the secure default", () => {
    const own = sessionConfigOf(loadHookConfig({}));
    expect(readSessionConfig(sessionConfigOf(loadHookConfig({ JEV_PATTERN_TRIPS: "advisory" })), own)?.patternTrips).toBe("advisory");
    expect(readSessionConfig({ ...own, patternTrips: "whatever" }, own)?.patternTrips).toBe("ask");
    const { patternTrips: _dropped, ...legacy } = own;
    expect(readSessionConfig(legacy, own)?.patternTrips).toBe("ask");
  });

  /**
   * 0.2.x installs carry `gate_mode`. Ignoring it would silently change the
   * gate under someone who had turned it off, so it is read, mapped, and
   * reported — the warning is what `/jev:status` prints.
   */
  describe("migration from gate_mode", () => {
    it("maps every old value and says so", () => {
      for (const [old, mapped] of [
        ["off", "off"],
        ["standard", "advisory"],
        ["strict", "strict"],
      ] as const) {
        const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE_MODE: old });
        expect(config.gate, old).toBe(mapped);
        expect(config.warnings.join(" ")).toContain(`gate_mode is deprecated; read as gate=${mapped}`);
      }
    });

    it("reads the JEV_ env form too", () => {
      expect(loadHookConfig({ JEV_GATE_MODE: "off" }).gate).toBe("off");
    });

    it("prefers an explicit gate and then says nothing about the old setting", () => {
      const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE: "off", CLAUDE_PLUGIN_OPTION_GATE_MODE: "strict" });
      expect(config.gate).toBe("off");
      expect(config.warnings.join(" ")).not.toContain("gate_mode");
    });

    it("warns about an unreadable old value instead of guessing", () => {
      const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE_MODE: "maybe" });
      expect(config.gate).toBe("advisory");
      expect(config.warnings.join(" ")).toContain("gate_mode=\"maybe\"");
    });

    it("says plainly that auto_mode no longer does anything", () => {
      const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_MODE: "ask" });
      expect(config.warnings.join(" ")).toContain("auto_mode is no longer used");
      expect(config.warnings.join(" ")).toContain("never prompts");
    });

    it("stays quiet when neither legacy setting is present", () => {
      expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_GATE: "advisory" }).warnings).toEqual([]);
    });
  });

  it("reads booleans in every documented spelling", () => {
    for (const value of ["true", "1", "yes", "on", "TRUE"]) {
      expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_ROUTE_PROMPTS: value }).routePrompts, value).toBe(true);
    }
    for (const value of ["false", "0", "no", "off"]) {
      expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_STOP_CHECK: value }).stopCheck, value).toBe(false);
    }
  });

  it("warns on a boolean it cannot read", () => {
    const config = loadHookConfig({ CLAUDE_PLUGIN_OPTION_STOP_CHECK: "sometimes" });
    expect(config.stopCheck).toBe(true);
    expect(config.warnings.join(" ")).toContain("stop_check");
  });

  it("reads a threshold and rejects one out of range", () => {
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_THRESHOLD: "0.9" }).autoThreshold).toBe(0.9);
    const bad = loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_THRESHOLD: "7" });
    expect(bad.autoThreshold).toBe(0.85);
    expect(bad.warnings.join(" ")).toContain("auto_threshold");
  });

  /**
   * A Choice's `confidence` is a peakedness statistic, not a probability of a
   * binary event, so it has its own bar rather than sharing `auto_threshold`.
   */
  it("reads confidence_threshold, separately from the certainty threshold", () => {
    expect(loadHookConfig({}).confidenceThreshold).toBe(0.85);
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_CONFIDENCE_THRESHOLD: "0.6" }).confidenceThreshold).toBe(0.6);
    expect(loadHookConfig({ JEV_CONFIDENCE_THRESHOLD: "0.95" }).confidenceThreshold).toBe(0.95);
    // Changing one leaves the other exactly where it was.
    const tuned = loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_THRESHOLD: "0.7" });
    expect(tuned.autoThreshold).toBe(0.7);
    expect(tuned.confidenceThreshold).toBe(0.85);
  });

  it("warns and falls back on a confidence_threshold outside its range", () => {
    const bad = loadHookConfig({ JEV_CONFIDENCE_THRESHOLD: "0.2" });
    expect(bad.confidenceThreshold).toBe(0.85);
    expect(bad.warnings.join(" ")).toContain("confidence_threshold");
  });

  it("never lets the review threshold exceed the auto threshold", () => {
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_AUTO_THRESHOLD: "0.5" }).reviewThreshold).toBeLessThanOrEqual(0.5);
  });

  it("honours JEV_HOOKS_DISABLE", () => {
    expect(loadHookConfig({ JEV_HOOKS_DISABLE: "1" }).disabled).toBe(true);
    expect(loadHookConfig({}).disabled).toBe(false);
  });

  it("strips a trailing slash from the base url", () => {
    expect(loadHookConfig({ TYPESAFE_BASE_URL: "https://x.example/" }).baseUrl).toBe("https://x.example");
  });
});

describe("resolveDataDir", () => {
  it("uses CLAUDE_PLUGIN_DATA when Claude Code provides it", () => {
    expect(resolveDataDir({ CLAUDE_PLUGIN_DATA: "/tmp/data" })).toBe("/tmp/data");
  });

  it("falls back to the documented location under the home directory", () => {
    expect(resolveDataDir({ HOME: "/home/dev" })).toBe(join("/home/dev", ".claude", "plugins", "data", "jev"));
    expect(resolveDataDir({})).toBe(join(homedir(), ".claude", "plugins", "data", "jev"));
  });

  // A /jev:* command runs through the Bash tool, where CLAUDE_PLUGIN_DATA is not
  // exported. It has to land on the directory the hooks write to.
  it("derives the install id from an installed plugin's script path", () => {
    const script = "/home/dev/.claude/plugins/cache/brainwires-jev/jev/0.1.0/dist/hook.mjs";
    expect(resolveDataDir({ HOME: "/home/dev" }, script)).toBe(
      join("/home/dev", ".claude", "plugins", "data", "jev-brainwires-jev"),
    );
    expect(installIdFromScriptPath("C:\\Users\\dev\\.claude\\plugins\\cache\\my.market\\jev\\1.0.0\\dist\\hook.mjs")).toBe(
      "jev-my-market",
    );
  });

  it("prefers CLAUDE_PLUGIN_DATA over the derived id, and ignores paths outside the plugin cache", () => {
    const script = "/home/dev/.claude/plugins/cache/brainwires-jev/jev/0.1.0/dist/hook.mjs";
    expect(resolveDataDir({ CLAUDE_PLUGIN_DATA: "/tmp/data" }, script)).toBe("/tmp/data");
    expect(installIdFromScriptPath("/repo/jevwire/plugin/dist/hook.mjs")).toBeUndefined();
    expect(installIdFromScriptPath("/x/cache/a/b/1/dist/hook.mjs")).toBeUndefined();
    expect(installIdFromScriptPath(undefined)).toBeUndefined();
  });
});

describe("daemon settings", () => {
  it("defaults to the port the plugin manifest hard-codes into its hook URLs", () => {
    // `hooks.json` can interpolate environment variables into headers only, so
    // the URL carries a literal and these two have to agree.
    expect(loadHookConfig({}).daemonPort).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(10522);
  });

  it("defaults to a thirty minute idle window", () => {
    expect(loadHookConfig({}).daemonIdleMs).toBe(30 * 60 * 1000);
  });

  it("reads the port from either name", () => {
    expect(loadHookConfig({ JEV_DAEMON_PORT: "10599" }).daemonPort).toBe(10599);
    expect(loadHookConfig({ CLAUDE_PLUGIN_OPTION_DAEMON_PORT: "10598" }).daemonPort).toBe(10598);
  });

  it("allows port 0, which is how the tests stay off the real one", () => {
    const config = loadHookConfig({ JEV_DAEMON_PORT: "0" });
    expect(config.daemonPort).toBe(0);
    expect(config.warnings).toEqual([]);
  });

  it("warns and falls back rather than throwing on a nonsense port", () => {
    for (const bad of ["-1", "70000", "http", ""]) {
      const config = loadHookConfig({ JEV_DAEMON_PORT: bad });
      expect(config.daemonPort, bad).toBe(DEFAULT_PORT);
    }
    expect(loadHookConfig({ JEV_DAEMON_PORT: "70000" }).warnings.join(" ")).toContain("daemon_port");
  });

  it("clamps the idle window to something a daemon can actually use", () => {
    expect(loadHookConfig({ JEV_DAEMON_IDLE_MS: "60000" }).daemonIdleMs).toBe(60_000);
    expect(loadHookConfig({ JEV_DAEMON_IDLE_MS: "1" }).daemonIdleMs).toBe(30 * 60 * 1000);
    expect(loadHookConfig({ JEV_DAEMON_IDLE_MS: "999999999" }).daemonIdleMs).toBe(30 * 60 * 1000);
  });
});

describe("the session config snapshot", () => {
  it("carries every setting the daemon needs and no secret", () => {
    const snapshot = sessionConfigOf(loadHookConfig({ TYPESAFE_API_KEY: "sk-secret", JEV_GATE: "strict" }));
    expect(snapshot.gate).toBe("strict");
    expect(JSON.stringify(snapshot)).not.toContain("sk-secret");
    expect(snapshot).not.toHaveProperty("apiKey");
    expect(snapshot).not.toHaveProperty("dataDir");
    expect(snapshot).not.toHaveProperty("disabled");
    expect(snapshot).not.toHaveProperty("warnings");
  });

  it("round-trips through validation unchanged", () => {
    const snapshot = sessionConfigOf(loadHookConfig({ JEV_GATE: "strict", JEV_ROUTE_PROMPTS: "1" }));
    expect(readSessionConfig(snapshot, sessionConfigOf(loadHookConfig({})))).toEqual(snapshot);
  });

  it("replaces every unusable field with the daemon's own value", () => {
    const own = sessionConfigOf(loadHookConfig({}));
    const read = readSessionConfig(
      {
        gate: "wide-open",
        autoThreshold: 42,
        reviewThreshold: -1,
        timeoutMs: 0,
        stopCheck: "yes",
        model: "",
        daemonPort: 999_999,
      },
      own,
    );
    expect(read).toEqual(own);
  });

  it("never lets a snapshot raise the review threshold above the auto one", () => {
    const own = sessionConfigOf(loadHookConfig({}));
    const read = readSessionConfig({ autoThreshold: 0.7, reviewThreshold: 0.95 }, own);
    expect(read?.autoThreshold).toBe(0.7);
    expect(read?.reviewThreshold).toBe(0.7);
  });

  it("rejects a snapshot that is not an object at all", () => {
    const own = sessionConfigOf(loadHookConfig({}));
    for (const bad of [null, undefined, 42, "gate=off", [1, 2]]) {
      expect(readSessionConfig(bad, own), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("rebuilds a full config from a snapshot plus this daemon's secrets", () => {
    const own = loadHookConfig({ JEV_GATE: "strict" });
    const rebuilt = hookConfigFrom(sessionConfigOf(own), "sk-daemon", "/tmp/data");
    expect(rebuilt.gate).toBe("strict");
    expect(rebuilt.apiKey).toBe("sk-daemon");
    expect(rebuilt.dataDir).toBe("/tmp/data");
    // The kill switch is never inherited: it stops the hook before the daemon.
    expect(rebuilt.disabled).toBe(false);
    expect(rebuilt.warnings).toEqual([]);
  });
});
