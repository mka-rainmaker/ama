import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-arrow");
const id = (qualifiedName: string) => symbolId({ file: "arrow.ts", qualifiedName });

describe("TypeScriptAnalyzer function-valued const declarations", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["arrow.ts"]);
  });

  it("emits a Function node for an arrow-assigned const", () => {
    expect(result.nodes.find((n) => n.id === id("greet"))?.kind).toBe("Function");
  });

  it("emits a Function node for a function-expression const", () => {
    expect(result.nodes.find((n) => n.id === id("compute"))?.kind).toBe("Function");
  });

  it("does not emit a node for a non-function const", () => {
    expect(result.nodes.some((n) => n.id === id("NOT_A_FN"))).toBe(false);
  });
});
