import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-implements");
const id = (qualifiedName: string) => symbolId({ file: "impl.ts", qualifiedName });

describe("TypeScriptAnalyzer implements resolution", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["impl.ts"]);
  });

  const implementsEdges = () => result.edges.filter((e) => e.kind === "Implements");

  it("links a class to the interface it implements", () => {
    expect(
      implementsEdges().some((e) => e.from === id("FriendlyGreeter") && e.to === id("Greeter")),
    ).toBe(true);
  });

  it("emits one Implements edge per interface in a multi-interface clause", () => {
    expect(implementsEdges().some((e) => e.from === id("Person") && e.to === id("Greeter"))).toBe(
      true,
    );
    expect(implementsEdges().some((e) => e.from === id("Person") && e.to === id("Named"))).toBe(
      true,
    );
  });

  it("does not emit Implements edges for a class with no heritage", () => {
    expect(implementsEdges().some((e) => e.from === id("Plain"))).toBe(false);
  });
});
