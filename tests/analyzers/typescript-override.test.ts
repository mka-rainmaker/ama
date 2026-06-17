import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-override");
const id = (qualifiedName: string) => symbolId({ file: "override.ts", qualifiedName });

const calls = (result: AnalysisResult, from: string, to: string) =>
  result.edges.some((e) => e.kind === "Calls" && e.from === id(from) && e.to === id(to));

describe("TypeScriptAnalyzer method override / virtual dispatch", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["override.ts"]);
  });

  it("resolves a base-class method call to the base method", () => {
    expect(calls(result, "use", "Base.run")).toBe(true);
  });

  it("fans a base-class method call out to the subclass override", () => {
    expect(calls(result, "use", "Derived.run")).toBe(true);
  });
});
