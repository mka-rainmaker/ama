import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-express");
const id = (qualifiedName: string) => symbolId({ file: "app.ts", qualifiedName });

describe("TypeScriptAnalyzer edge provenance (ama-m8k.1)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["app.ts"]);
  });

  it("marks a heuristically-detected route reference as heuristic", () => {
    const edge = result.edges.find(
      (e) => e.kind === "References" && e.from === id("GET /users") && e.to === id("listUsers"),
    );
    expect(edge?.provenance).toBe("heuristic");
  });

  it("leaves a checker-resolved call edge unmarked (resolved by default)", () => {
    const edge = result.edges.find(
      (e) => e.kind === "Calls" && e.from === id("POST /users handler") && e.to === id("audit"),
    );
    expect(edge).toBeDefined();
    expect(edge?.provenance).toBeUndefined();
  });
});
