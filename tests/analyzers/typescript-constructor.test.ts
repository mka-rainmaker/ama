import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-constructor");
const id = (qualifiedName: string) => symbolId({ file: "cls.ts", qualifiedName });

describe("TypeScriptAnalyzer constructor nodes (ama-vz8)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["cls.ts"]);
  });

  it("emits a Method node for a class constructor", () => {
    expect(result.nodes.find((n) => n.id === id("Widget.constructor"))?.kind).toBe("Method");
  });

  it("attributes a call in the constructor body to the constructor", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "Calls" && e.from === id("Widget.constructor") && e.to === id("setup"),
      ),
    ).toBe(true);
  });

  it("attributes a variable read in the constructor body to the constructor", () => {
    expect(
      result.edges.some(
        (e) =>
          e.kind === "References" && e.from === id("Widget.constructor") && e.to === id("LIMIT"),
      ),
    ).toBe(true);
  });
});
