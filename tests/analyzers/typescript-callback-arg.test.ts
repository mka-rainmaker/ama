import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-callback-arg");
const id = (qualifiedName: string) => symbolId({ file: "app.ts", qualifiedName });

describe("TypeScriptAnalyzer inline callback arguments (ama-y9q)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["app.ts"]);
  });

  it("synthesizes a Function node for a string-named callback in value position", () => {
    expect(result.nodes.find((n) => n.id === id("work handler"))?.kind).toBe("Function");
  });

  it("attributes the synthesized handler's body calls to its node", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "Calls" && e.from === id("work handler") && e.to === id("helper"),
      ),
    ).toBe(true);
  });

  it("links the enclosing function to the synthesized handler with a References edge", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "References" && e.from === id("setup") && e.to === id("work handler"),
      ),
    ).toBe(true);
  });

  it("does not synthesize a node for a fire-and-forget statement callback", () => {
    // `each("ignored", () => …)` is a bare statement (test-harness shape) — it must
    // stay transparent, or every describe()/it() in the suite would become a node.
    expect(result.nodes.some((n) => n.id === id("ignored handler"))).toBe(false);
  });

  it("leaves a transparent callback's body calls attributed to the enclosing scope", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "Calls" && e.from === id("setup") && e.to === id("audited"),
      ),
    ).toBe(true);
  });
});
