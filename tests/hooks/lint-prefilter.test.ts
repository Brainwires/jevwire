import { describe, expect, it } from "vitest";
import { entropyBitsPerChar, lineDiff, lintPrefilter, type LintEditInput } from "../../src/hooks/lint-prefilter.js";

function edit(overrides: Partial<LintEditInput> & { new: string }): LintEditInput {
  return { tool: "Edit", file_path: "src/app.ts", ...overrides };
}

describe("lintPrefilter skips", () => {
  it("skips a whitespace-only change", () => {
    expect(lintPrefilter(edit({ old: "const x = 1", new: "const   x =   1" })).kind).toBe("skip");
  });

  it("skips a pure rename", () => {
    const v = lintPrefilter(edit({ old: "function foo(a) { return foo(a); }", new: "function bar(a) { return bar(a); }" }));
    expect(v).toEqual({ kind: "skip", reason: "pure-rename" });
  });

  it("skips a non-code file", () => {
    expect(lintPrefilter(edit({ file_path: "README.md", old: "a", new: "b about a secret token = xyz" })).reason).toBe(
      "non-code-file",
    );
  });

  it("skips an over-large change", () => {
    expect(lintPrefilter(edit({ old: "x".repeat(30_000), new: "y".repeat(20_000) })).reason).toBe("too-large");
  });

  it("skips a change matching no gate when there are no conventions", () => {
    expect(lintPrefilter(edit({ old: "const a = 1", new: "const a = 2" }))).toEqual({ kind: "skip", reason: "no-gate" });
  });

  it("judges a no-gate change when conventions exist", () => {
    const v = lintPrefilter(edit({ old: "const a = 1", new: "const a = 2" }), true);
    expect(v.kind).toBe("judge");
    if (v.kind === "judge") expect(v.ask).toEqual([]);
  });
});

describe("lintPrefilter gates", () => {
  const gate = (input: Partial<LintEditInput> & { new: string }) => {
    const v = lintPrefilter(edit(input));
    return v.kind === "judge" ? v.ask : [];
  };

  it("fires removes_test on a deleted assertion", () => {
    expect(gate({ old: "expect(x).toBe(1)\nfoo()", new: "foo()" })).toContain("removes_test");
  });

  it("fires removes_test on an added .skip", () => {
    expect(gate({ old: "it('works', fn)", new: "it.skip('works', fn)" })).toContain("removes_test");
  });

  it("fires swallows_exception on a new catch", () => {
    expect(gate({ old: "doThing()", new: "try { doThing() } catch (e) {}" })).toContain("swallows_exception");
  });

  it("fires hardcodes_secret on a keyed secret and a high-entropy literal", () => {
    expect(gate({ old: "", new: 'const apiKey = "sk-live-abcd"' })).toContain("hardcodes_secret");
    expect(gate({ old: "", new: 'const t = "aGVsbG8td29ybGQtc2VjcmV0LXZhbHVl1234"' })).toContain("hardcodes_secret");
  });

  it("does not fire hardcodes_secret on a low-entropy literal", () => {
    expect(gate({ old: "", new: 'const t = "aaaaaaaaaaaaaaaaaaaaaaaa"' })).not.toContain("hardcodes_secret");
  });

  it("fires hardcodes_url_or_path on a URL and an absolute path", () => {
    expect(gate({ old: "", new: 'fetch("https://api.example.com")' })).toContain("hardcodes_url_or_path");
    expect(gate({ old: "", new: 'open("/Users/dana/data.csv")' })).toContain("hardcodes_url_or_path");
  });

  it("fires adds_suppression on a new @ts-ignore or any", () => {
    expect(gate({ old: "const x = f()", new: "// @ts-ignore\nconst x = f()" })).toContain("adds_suppression");
    expect(gate({ old: "let x: number", new: "let x: any" })).toContain("adds_suppression");
  });

  it("fires changes_public_signature on an exported declaration", () => {
    expect(gate({ old: "export function run(a) {}", new: "export function run(a, b) {}" })).toContain(
      "changes_public_signature",
    );
  });

  it("fires leaves_placeholder on a TODO or a not-implemented throw", () => {
    expect(gate({ old: "", new: 'function f() { throw new Error("not implemented") }' })).toContain("leaves_placeholder");
  });

  it("on a config file asks only the secret and url/path gates", () => {
    const v = lintPrefilter(edit({ file_path: "config.json", old: "{}", new: '{ "token": "sk-abc", "catch": "x" }' }));
    if (v.kind === "judge") {
      expect(v.ask).toContain("hardcodes_secret");
      expect(v.ask).not.toContain("swallows_exception");
    }
  });
});

describe("helpers", () => {
  it("entropyBitsPerChar separates a key from a repeated char", () => {
    expect(entropyBitsPerChar("aaaaaaaa")).toBeLessThan(1);
    expect(entropyBitsPerChar("aGVsbG8td29ybGQ0Nzkx")).toBeGreaterThan(3.5);
  });

  it("lineDiff reports added and removed non-blank lines", () => {
    const d = lineDiff("a\nb\nc", "a\nc\nd");
    expect(d.removed).toEqual(["b"]);
    expect(d.added).toEqual(["d"]);
  });
});
