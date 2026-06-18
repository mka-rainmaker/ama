import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-usestype");
const id = (qualifiedName: string) => symbolId({ file: "usetype.ts", qualifiedName });

describe("TypeScriptAnalyzer Returns edges (ama-37c)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["usetype.ts"]);
  });

  const has = (kind: string, from: string, to: string) =>
    result.edges.some((e) => e.kind === kind && e.from === from && e.to === to);

  it("emits a Returns edge from a function to its returned type", () => {
    expect(has("Returns", id("build"), id("Gadget"))).toBe(true);
  });

  it("emits a Returns edge from a method to its returned type", () => {
    expect(has("Returns", id("Factory.make"), id("Gadget"))).toBe(true);
  });

  it("keeps the parameter type as a UsesType edge, distinct from the return", () => {
    expect(has("UsesType", id("build"), id("Widget"))).toBe(true);
    // The return type is no longer conflated into UsesType.
    expect(has("UsesType", id("build"), id("Gadget"))).toBe(false);
  });
});
