import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-implements");
const id = (qualifiedName: string) => symbolId({ file: "impl.ts", qualifiedName });

describe("TypeScriptAnalyzer Overrides edges (ama-hft.11)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["impl.ts"]);
  });

  const overrides = (from: string, to: string) =>
    result.edges.some((e) => e.kind === "Overrides" && e.from === id(from) && e.to === id(to));

  it("links an implementing method to the interface method it overrides", () => {
    expect(overrides("FriendlyGreeter.greet", "Greeter.greet")).toBe(true);
  });

  it("emits Overrides for each implemented method of a multi-interface class", () => {
    expect(overrides("Person.greet", "Greeter.greet")).toBe(true);
    expect(overrides("Person.name", "Named.name")).toBe(true);
  });
});
