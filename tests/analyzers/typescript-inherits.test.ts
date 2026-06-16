import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-inherits");
const id = (qualifiedName: string) => symbolId({ file: "inherit.ts", qualifiedName });

describe("TypeScriptAnalyzer inherits resolution", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["inherit.ts"]);
  });

  const inheritsEdges = () => result.edges.filter((e) => e.kind === "Inherits");
  const implementsEdges = () => result.edges.filter((e) => e.kind === "Implements");

  it("links a subclass to the base class it extends", () => {
    expect(inheritsEdges().some((e) => e.from === id("Dog") && e.to === id("Animal"))).toBe(true);
  });

  it("keeps extends and implements clauses on the same class distinct", () => {
    // `extends Dog` → Inherits, `implements Trainable` → Implements.
    expect(inheritsEdges().some((e) => e.from === id("ServiceDog") && e.to === id("Dog"))).toBe(
      true,
    );
    expect(
      implementsEdges().some((e) => e.from === id("ServiceDog") && e.to === id("Trainable")),
    ).toBe(true);
    // ...and not the other way around.
    expect(
      inheritsEdges().some((e) => e.from === id("ServiceDog") && e.to === id("Trainable")),
    ).toBe(false);
    expect(implementsEdges().some((e) => e.from === id("ServiceDog") && e.to === id("Dog"))).toBe(
      false,
    );
  });

  it("does not emit Inherits edges for a class with no heritage", () => {
    expect(inheritsEdges().some((e) => e.from === id("Standalone"))).toBe(false);
  });
});
