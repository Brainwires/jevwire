import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConventionsCache, extractConventions, readProjectConventions } from "../../src/hooks/conventions.js";

describe("extractConventions", () => {
  it("keeps rule-shaped code lines and drops prose", () => {
    const text = [
      "# Project",
      "This project does great things and we care about quality.",
      "- Always run `bun test` before committing.",
      "- We value clarity.",
      "- Never use `any`; prefer a real type.",
      "- The weather is nice.",
    ].join("\n");
    const out = extractConventions(text);
    expect(out).toContain("Always run `bun test` before committing.");
    expect(out).toContain("Never use `any`; prefer a real type.");
    expect(out).not.toContain("We value clarity.");
    expect(out).not.toContain("The weather is nice.");
  });

  it("puts lines under a conventions heading first", () => {
    const text = [
      "- Prefer `const` over `let` where possible.",
      "## Conventions",
      "- Always export types from `index.ts`.",
    ].join("\n");
    const out = extractConventions(text);
    expect(out[0]).toBe("Always export types from `index.ts`.");
  });

  it("caps the number of conventions", () => {
    const text = Array.from({ length: 30 }, (_v, i) => `- Always use \`helper${i}\` for module ${i}.`).join("\n");
    expect(extractConventions(text, 12)).toHaveLength(12);
  });
});

describe("readProjectConventions", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jev-conv-"));
    clearConventionsCache();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads CLAUDE.md and .claude/CLAUDE.md and caches until they change", () => {
    writeFileSync(join(root, "CLAUDE.md"), "- Always run `npm test` before a commit.\n");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "CLAUDE.md"), "- Never commit a `console.log`.\n");

    const first = readProjectConventions(root);
    expect(first).toContain("Always run `npm test` before a commit.");
    expect(first).toContain("Never commit a `console.log`.");

    // Cached: a change without a new mtime is not re-read (same call returns same list).
    expect(readProjectConventions(root)).toEqual(first);
  });

  it("returns nothing when there is no CLAUDE.md", () => {
    expect(readProjectConventions(root)).toEqual([]);
  });
});
