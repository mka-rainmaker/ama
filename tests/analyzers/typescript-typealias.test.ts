import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-typealias");
const id = (qualifiedName: string) => symbolId({ file: "types.ts", qualifiedName });

describe("TypeScriptAnalyzer type alias nodes", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["types.ts"]);
  });

  it("emits a node for a type alias declaration", () => {
    const node = result.nodes.find((n) => n.id === id("Status"));
    expect(node?.kind).toBe("TypeAlias");
  });

  it("links a function to a type alias it uses via a UsesType edge", () => {
    const used = result.edges.some(
      (e) => e.kind === "UsesType" && e.from === id("label") && e.to === id("Status"),
    );
    expect(used).toBe(true);
  });
});
