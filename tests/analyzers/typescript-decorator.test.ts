import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-decorator");
const id = (qualifiedName: string) => symbolId({ file: "decorated.ts", qualifiedName });

describe("TypeScriptAnalyzer decorator usage edges", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["decorated.ts"]);
  });

  it("emits a UsesType edge from a class to its decorator", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "UsesType" && e.from === id("Widget") && e.to === id("sealed"),
      ),
    ).toBe(true);
  });

  it("emits a UsesType edge from a method to its (call-form) decorator", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "UsesType" && e.from === id("Widget.render") && e.to === id("log"),
      ),
    ).toBe(true);
  });

  it("does not emit a spurious Calls edge for a decorator application", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "Calls" && e.from === id("Widget.render") && e.to === id("log"),
      ),
    ).toBe(false);
  });
});
