import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-calls");
const id = (qualifiedName: string) => symbolId({ file: "calls.ts", qualifiedName });

describe("TypeScriptAnalyzer call resolution", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["calls.ts"]);
  });

  const calls = () => result.edges.filter((e) => e.kind === "Calls");

  it("links a function call to its callee", () => {
    expect(calls().some((e) => e.from === id("main") && e.to === id("helper"))).toBe(true);
  });

  it("resolves a method-to-method call through `this`", () => {
    expect(
      calls().some((e) => e.from === id("Service.run") && e.to === id("Service.compute")),
    ).toBe(true);
  });

  it("resolves a method calling a free function", () => {
    expect(calls().some((e) => e.from === id("Service.compute") && e.to === id("helper"))).toBe(
      true,
    );
  });

  it("does not invent calls between unrelated symbols", () => {
    expect(calls().some((e) => e.from === id("main") && e.to === id("Service.run"))).toBe(false);
  });
});
