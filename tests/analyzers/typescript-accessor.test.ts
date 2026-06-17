import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-accessor");
const id = (qualifiedName: string) => symbolId({ file: "accessor.ts", qualifiedName });

describe("TypeScriptAnalyzer get/set accessors as nodes", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["accessor.ts"]);
  });

  it("emits a Property node for a get/set accessor", () => {
    expect(result.nodes.find((n) => n.id === id("Box.value"))?.kind).toBe("Property");
  });

  it("attributes a getter's return type to the accessor node", () => {
    const hit = result.edges.some(
      (e) => e.kind === "UsesType" && e.from === id("Box.value") && e.to === id("Widget"),
    );
    expect(hit).toBe(true);
  });
});
