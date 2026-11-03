/**
 * Every place that carries a version has to agree.
 *
 * Five places, and a mismatch is invisible locally: a marketplace entry whose
 * version disagrees with the plugin manifest installs fine and then reports the
 * wrong thing, and an `SERVER_VERSION` left behind tells every MCP client the
 * previous release is running. `npm run bump` is what keeps them together; this
 * is what proves it did.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { editsFor, plan, VERSION_PATTERN } from "../scripts/bump.js";
import { HOOK_VERSION } from "../src/hooks/version.js";
import { SERVER_VERSION } from "../src/server.js";

const root = fileURLToPath(new URL("..", import.meta.url));

const read = (file: string): string => readFileSync(new URL(file, new URL("..", import.meta.url)), "utf8");
const json = (file: string): Record<string, unknown> => JSON.parse(read(file)) as Record<string, unknown>;

const pkg = json("package.json");
const lock = json("package-lock.json");
const plugin = json("plugin/.claude-plugin/plugin.json");
const marketplace = json(".claude-plugin/marketplace.json");

describe("versions agree", () => {
  it("package.json carries an exact semver version", () => {
    expect(pkg.version).toMatch(VERSION_PATTERN);
  });

  it("the plugin manifest matches package.json", () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it("the marketplace entry matches the plugin manifest", () => {
    const plugins = marketplace.plugins as { name: string; version: string }[];
    const entry = plugins.find((candidate) => candidate.name === plugin.name);
    expect(entry, "the marketplace must list the plugin by name").toBeDefined();
    expect(entry!.version).toBe(pkg.version);
  });

  it("SERVER_VERSION matches package.json, so MCP clients report the truth", () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it("HOOK_VERSION matches package.json, so the daemon reports the truth", () => {
    // The hook bundle cannot import SERVER_VERSION without dragging the MCP SDK
    // in, so it has its own constant — and `ensureDaemon` replaces a daemon by
    // comparing what health reports against what the caller shipped with.
    expect(HOOK_VERSION).toBe(pkg.version);
  });

  it("the lockfile matches package.json, in both places it says so", () => {
    expect(lock.version).toBe(pkg.version);
    const packages = lock.packages as Record<string, { version?: string }> | undefined;
    expect(packages?.[""]?.version).toBe(pkg.version);
  });

  it("the marketplace and plugin descriptions do not drift apart", () => {
    const plugins = marketplace.plugins as { name: string; description: string }[];
    const entry = plugins.find((candidate) => candidate.name === plugin.name);
    expect(entry!.description).toBe(plugin.description);
  });
});

describe("npm run bump", () => {
  it("rewrites every version-bearing file", () => {
    const planned = plan("9.9.9", read);
    expect(planned.map((item) => item.file).sort()).toEqual(
      [
        ".claude-plugin/marketplace.json",
        "package-lock.json",
        "package.json",
        "plugin/.claude-plugin/plugin.json",
        "src/hooks/version.ts",
        "src/server.ts",
      ].sort(),
    );
    for (const item of planned) {
      expect(item.next, item.file).toContain("9.9.9");
      expect(item.next, item.file).not.toBe(read(item.file));
    }
  });

  it("covers exactly the files this test asserts on", () => {
    // If someone adds a version to a new file, both lists have to grow.
    expect(editsFor("@brainwires/jevwire")).toHaveLength(6);
  });

  it("leaves dependency versions alone", () => {
    const planned = plan("9.9.9", read);
    const nextPkg = JSON.parse(planned.find((item) => item.file === "package.json")!.next) as {
      version: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(nextPkg.version).toBe("9.9.9");
    expect(nextPkg.dependencies.zod).toBe((pkg.dependencies as Record<string, string>).zod);
    expect(nextPkg.devDependencies.vitest).toBe((pkg.devDependencies as Record<string, string>).vitest);
  });

  it("rewrites both lockfile entries and nothing else in it", () => {
    const planned = plan("9.9.9", read);
    const next = planned.find((item) => item.file === "package-lock.json")!;
    const parsed = JSON.parse(next.next) as { version: string; packages: Record<string, { version?: string }> };
    expect(parsed.version).toBe("9.9.9");
    expect(parsed.packages[""]!.version).toBe("9.9.9");
    // Nested dependency versions are untouched: only two lines changed.
    const before = read("package-lock.json").split("\n");
    const after = next.next.split("\n");
    expect(after).toHaveLength(before.length);
    const changed = after.filter((line, index) => line !== before[index]);
    expect(changed).toHaveLength(2);
  });

  it("refuses anything that is not an exact version", () => {
    for (const bad of ["", "1.2", "^1.2.3", "v1.2.3", "latest", "1.2.3.4"]) {
      expect(() => plan(bad, read), bad).toThrowError(/exact semver/);
    }
  });

  it("refuses to write anything when a file's shape changed", () => {
    const broken = (file: string): string => (file === "src/server.ts" ? "// no version here\n" : read(file));
    expect(() => plan("9.9.9", broken)).toThrowError(/src\/server\.ts/);
  });
});

describe("the package manifest is publishable", () => {
  it("names the fields a registry page needs", () => {
    expect(pkg.repository).toBeDefined();
    expect(pkg.bugs).toBeDefined();
    expect(pkg.homepage).toBeDefined();
    expect(pkg.license).toBe("MIT");
    expect((pkg.engines as { node: string }).node).toContain("20");
    expect(pkg.keywords as string[]).toContain("claude-code");
  });

  it("ships the plugin and the built library, and nothing from tests", () => {
    const files = pkg.files as string[];
    expect(files).toContain("dist");
    expect(files).toContain("plugin");
    expect(files).toContain(".claude-plugin");
    expect(files).toContain("CHANGELOG.md");
    expect(files.some((entry) => entry.startsWith("tests"))).toBe(false);
    expect(files.some((entry) => entry.startsWith("src"))).toBe(false);
  });

  it("declares the bump script the release process depends on", () => {
    expect((pkg.scripts as Record<string, string>).bump).toBe("tsx scripts/bump.ts");
  });

  it("does not leave the root directory unversioned", () => {
    expect(pkg.name).toBe("@brainwires/jevwire");
    expect(pkg.bin).toEqual({ jevwire: "dist/index.js" });
  });
});
