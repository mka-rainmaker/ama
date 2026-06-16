import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-usestype");
const id = (qualifiedName: string) => symbolId({ file: "usetype.ts", qualifiedName });

describe("TypeScriptAnalyzer UsesType resolution", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["usetype.ts"]);
  });

  const usesType = () => result.edges.filter((e) => e.kind === "UsesType");
  const has = (from: string, to: string) => usesType().some((e) => e.from === from && e.to === to);

  it("links a function to its parameter and return types", () => {
    expect(has(id("build"), id("Widget"))).toBe(true);
    expect(has(id("build"), id("Gadget"))).toBe(true);
  });

  it("attributes a method's parameter and return types to the method", () => {
    expect(has(id("Factory.make"), id("Widget"))).toBe(true);
    expect(has(id("Factory.make"), id("Gadget"))).toBe(true);
  });

  it("attributes a property's type to its enclosing class (properties aren't nodes yet)", () => {
    expect(has(id("Holder"), id("Widget"))).toBe(true);
    // No member-level node exists, so nothing is attributed to a phantom property id.
    expect(usesType().some((e) => e.from === id("Holder.item"))).toBe(false);
  });

  it("finds type references nested inside composite annotations", () => {
    expect(has(id("many"), id("Widget"))).toBe(true);
  });

  it("emits no UsesType edge for a purely primitive signature", () => {
    expect(usesType().some((e) => e.from === id("plain"))).toBe(false);
  });
});
