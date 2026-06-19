import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-callbacks");
const id = (qualifiedName: string) => symbolId({ file: "cb.ts", qualifiedName });

describe("TypeScriptAnalyzer higher-order callback attribution (ama-hft.15)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["cb.ts"]);
  });

  const callback = (from: string, to: string) =>
    result.edges.find((e) => e.kind === "Calls" && e.from === id(from) && e.to === id(to));

  it("attributes a named callback passed to .map() as a Calls edge", () => {
    expect(callback("run", "transform")).toBeDefined();
  });

  it("attributes a named handler passed to .then() as a Calls edge", () => {
    expect(callback("go", "handler")).toBeDefined();
  });

  it("marks the callback edge heuristic — we assume the method invokes its arg", () => {
    expect(callback("run", "transform")?.provenance).toBe("heuristic");
  });
});
