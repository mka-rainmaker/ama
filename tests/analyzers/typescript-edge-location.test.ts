import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-calls");
const id = (qualifiedName: string) => symbolId({ file: "calls.ts", qualifiedName });

describe("TypeScriptAnalyzer call-site location (ama-hft.9)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["calls.ts"]);
  });

  it("records the line/column of a call on the Calls edge", () => {
    // `main` calls `helper()` on line 6 of calls.ts.
    const edge = result.edges.find(
      (e) => e.kind === "Calls" && e.from === id("main") && e.to === id("helper"),
    );
    expect(edge?.at).toEqual({ line: 6, column: 10 });
  });
});
