import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-new");
const id = (qualifiedName: string) => symbolId({ file: "build.ts", qualifiedName });

describe("TypeScriptAnalyzer new-expression Instantiates edges (ama-hft.11)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["build.ts"]);
  });

  it("emits a first-class Instantiates edge from a function to a class it constructs", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "Instantiates" && e.from === id("make") && e.to === id("Widget"),
      ),
    ).toBe(true);
  });

  it("does not fold construction into a Calls edge", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "Calls" && e.from === id("make") && e.to === id("Widget"),
      ),
    ).toBe(false);
  });
});
