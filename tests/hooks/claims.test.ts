import { describe, expect, it } from "vitest";
import {
  checkReferences,
  extractClaims,
  isProjectRelative,
  stopClaimsPolicy,
  type Stage1Context,
} from "../../src/hooks/claims.js";
import type { ClaimResult } from "../../src/tools/verify-core.js";

describe("extractClaims", () => {
  it("pulls file refs, backticked identifiers and change sentences", () => {
    const message =
      "I updated `parseConfig` in src/config.ts:12-20 and added a helper. " +
      "The old file src/legacy.ts was removed. See https://example.com/x.ts for docs.";
    const out = extractClaims(message);
    expect(out.files.map((f) => f.path)).toContain("src/config.ts");
    expect(out.files.find((f) => f.path === "src/config.ts")?.line).toBe(12);
    expect(out.files.find((f) => f.path === "src/legacy.ts")?.removal).toBe(true);
    expect(out.idents.map((i) => i.name)).toContain("parseConfig");
    // The identifier borrows the file named in its sentence.
    expect(out.idents.find((i) => i.name === "parseConfig")?.file).toBe("src/config.ts");
    expect(out.claims.some((c) => c.text.includes("updated"))).toBe(true);
  });

  it("ignores a URL path and a short or generic identifier", () => {
    expect(isProjectRelative("https://example.com/a.ts")).toBe(false);
    expect(isProjectRelative("/etc/passwd.sh")).toBe(false);
    expect(isProjectRelative("src/x.ts")).toBe(true);
    const out = extractClaims("Ran `npm` and touched `ab`.");
    expect(out.idents).toHaveLength(0);
  });

  it("does not bind descriptive identifiers to an unrelated only file", () => {
    const out = extractClaims(
      "The plugin exposes `route_prompts`, `jev_evaluate`, and `jev_rank`. Updated CLAUDE.md with setup notes.",
    );
    expect(out.idents).toHaveLength(3);
    for (const ident of out.idents) expect(ident.file).toBeUndefined();
  });

  it("still binds a changed identifier to the message's only file", () => {
    const out = extractClaims("Added `retryWithBackoff` for transient failures. The implementation is in src/client.ts.");
    expect(out.idents[0]?.file).toBe("src/client.ts");
  });
});

function context(overrides: Partial<Stage1Context>): Stage1Context {
  return {
    fileExists: () => "no",
    readFile: () => ({ kind: "missing" }),
    nameStatus: new Map(),
    diffText: "",
    ...overrides,
  };
}

describe("checkReferences (stage 1)", () => {
  it("marks a named-but-absent file as fabricated", () => {
    const extracted = extractClaims("I edited src/nope.ts to fix it.");
    const { files } = checkReferences(extracted, context({ fileExists: () => "no" }));
    expect(files[0]!.verdict).toBe("fabricated");
  });

  it("accepts a removal claim backed by a D status", () => {
    const extracted = extractClaims("Removed src/old.ts.");
    const { files } = checkReferences(
      extracted,
      context({ nameStatus: new Map([["src/old.ts", "D"]]), fileExists: () => "no" }),
    );
    expect(files[0]!.verdict).toBe("removed-ok");
  });

  it("flags a removal claim about a file that is still present and untouched", () => {
    const extracted = extractClaims("Removed src/here.ts.");
    const { files } = checkReferences(extracted, context({ fileExists: () => "yes", nameStatus: new Map() }));
    expect(files[0]!.verdict).toBe("fabricated");
  });

  it("marks an identifier that is in neither the file nor the diff as fabricated", () => {
    const extracted = extractClaims("Added `retryWithBackoff` to src/client.ts.");
    const { idents } = checkReferences(
      extracted,
      context({
        fileExists: () => "yes",
        readFile: () => ({ kind: "text", text: "export function unrelated() {}" }),
        diffText: "",
      }),
    );
    expect(idents[0]!.verdict).toBe("fabricated");
  });

  it("accepts an identifier present on a + line of the diff even if the file read races", () => {
    const extracted = extractClaims("Added `retryWithBackoff` to src/client.ts.");
    const { idents } = checkReferences(
      extracted,
      context({
        fileExists: () => "yes",
        readFile: () => ({ kind: "missing" }),
        diffText: "+  function retryWithBackoff() {}\n",
      }),
    );
    expect(idents[0]!.verdict).toBe("present");
  });

  it("does not fabricate an identifier when its bound file cannot be read", () => {
    const extracted = extractClaims("Added `retryWithBackoff` to src/client.ts.");
    const stage1 = checkReferences(
      extracted,
      context({
        fileExists: () => "yes",
        readFile: () => ({ kind: "missing" }),
        diffText: "",
      }),
    );
    expect(stage1.idents[0]!.verdict).toBe("unlocated");

    const result = stopClaimsPolicy(stage1, undefined, 0.85);
    expect(result.block).toBe(false);
    expect(result.counts.fabricated).toBe(0);
    expect(result.counts.unlocated).toBe(1);
  });

  it("does not fabricate a bare basename that lives deeper in the tree", () => {
    // `workspace.ts` in prose is a reference by name, not a path claim; it must
    // not block just because it is not at the project root.
    const extracted = extractClaims("I updated `workspace.ts` and `plugin.json` and `CLAUDE.md`.");
    const { files } = checkReferences(extracted, context({ fileExists: () => "no" }));
    for (const f of files) expect(f.verdict).toBe("unlocated");
  });

  it("still fabricates a path-shaped reference that does not resolve", () => {
    const extracted = extractClaims("I created src/nope.ts.");
    const { files } = checkReferences(extracted, context({ fileExists: () => "no" }));
    expect(files[0]!.verdict).toBe("fabricated");
  });

  it("does not count a refused (sensitive) path", () => {
    const extracted = extractClaims("Wrote config.json for the app.");
    const { files } = checkReferences(extracted, context({ fileExists: () => "refused" }));
    expect(files[0]!.verdict).toBe("refused");
  });
});

describe("stopClaimsPolicy", () => {
  const clean = { files: [], idents: [] };

  it("blocks on a fabricated file", () => {
    const extracted = extractClaims("I edited src/nope.ts.");
    const stage1 = checkReferences(extracted, context({ fileExists: () => "no" }));
    const result = stopClaimsPolicy(stage1, undefined, 0.85);
    expect(result.block).toBe(true);
    expect(result.items[0]!.verdict).toBe("fabricated");
    expect(result.counts.fabricated).toBe(1);
  });

  it("blocks on a firmly contradicted claim", () => {
    const verified: ClaimResult[] = [
      { claim: "renamed X to Y", verdict: "contradicted", probabilities: { contradicted: 0.93 }, confidence: 0.93, gate: "escalate" },
    ];
    const result = stopClaimsPolicy(clean, verified, 0.85);
    expect(result.block).toBe(true);
    expect(result.items[0]!.verdict).toBe("contradicted");
  });

  it("does not block on a soft contradiction, supported, or not_addressed", () => {
    const verified: ClaimResult[] = [
      { claim: "a", verdict: "contradicted", probabilities: { contradicted: 0.5 }, confidence: 0.5, gate: "escalate" },
      { claim: "b", verdict: "supported", probabilities: { supported: 0.9 }, confidence: 0.9, gate: "auto" },
      { claim: "c", verdict: "not_addressed", probabilities: {}, confidence: 0.2, gate: "escalate" },
    ];
    const result = stopClaimsPolicy(clean, verified, 0.85);
    expect(result.block).toBe(false);
    expect(result.counts.supported).toBe(1);
    expect(result.counts.not_addressed).toBe(1);
  });
});
