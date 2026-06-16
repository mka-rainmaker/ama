import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-dispatch");
const id = (qualifiedName: string) => symbolId({ file: "dispatch.ts", qualifiedName });

describe("TypeScriptAnalyzer interface-method dispatch", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["dispatch.ts"]);
  });

  it("emits a node for an interface method signature", () => {
    expect(result.nodes.find((n) => n.id === id("Service.run"))?.kind).toBe("Method");
  });

  it("resolves a call through an interface-typed value to the interface method", () => {
    const hit = result.edges.some(
      (e) => e.kind === "Calls" && e.from === id("useService") && e.to === id("Service.run"),
    );
    expect(hit).toBe(true);
  });

  it("fans an interface-method call out to the implementing class's method", () => {
    const hit = result.edges.some(
      (e) => e.kind === "Calls" && e.from === id("useService") && e.to === id("FastService.run"),
    );
    expect(hit).toBe(true);
  });
});
