import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-cycle");
const sym = (file: string, qn: string) => symbolId({ file, qualifiedName: qn });

describe("TypeScriptAnalyzer type-only imports (ama-bhf)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["a.ts", "b.ts", "c.ts", "d.ts"]);
  });

  it("emits an Imports edge for a value import", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "Imports" && e.from === "a.ts" && e.to === sym("b.ts", "b"),
      ),
    ).toBe(true);
  });

  it("emits an ImportsType edge for an `import type`", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "ImportsType" && e.from === "c.ts" && e.to === sym("d.ts", "D"),
      ),
    ).toBe(true);
  });

  it("does not emit a plain Imports edge for a type-only import", () => {
    expect(result.edges.some((e) => e.kind === "Imports" && e.from === "c.ts")).toBe(false);
  });
});
