import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-generics");
const id = (qualifiedName: string) => symbolId({ file: "generics.ts", qualifiedName });

const usesWidget = (result: AnalysisResult, from: string) =>
  result.edges.some((e) => e.kind === "UsesType" && e.from === id(from) && e.to === id("Widget"));

describe("TypeScriptAnalyzer generic instantiations", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["generics.ts"]);
  });

  it("emits UsesType for a generic type argument in a call expression", () => {
    expect(usesWidget(result, "viaCall")).toBe(true);
  });

  it("emits UsesType for a generic type argument in a new expression", () => {
    expect(usesWidget(result, "viaNew")).toBe(true);
  });
});
