import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import type { NodeKind } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-namespace");

describe("TypeScriptAnalyzer Module nodes (ama-hft.13)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["ns.ts"]);
  });

  const node = (kind: NodeKind, qualifiedName: string) =>
    result.nodes.find((n) => n.kind === kind && n.qualifiedName === qualifiedName);

  it("emits a Module node for a namespace", () => {
    expect(node("Module", "Geometry")).toBeDefined();
  });

  it("nests a namespace's members under it (Geometry.area, not bare area)", () => {
    expect(node("Function", "Geometry.area")).toBeDefined();
    expect(node("Function", "area")).toBeUndefined();
  });

  it("emits a Module node for an ambient module declaration", () => {
    expect(node("Module", "virtual:config")).toBeDefined();
  });
});
