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

  it("links a function to its parameter type (the return type is a Returns edge)", () => {
    expect(has(id("build"), id("Widget"))).toBe(true);
    // The return type is now a distinct Returns edge, not folded into UsesType.
    expect(has(id("build"), id("Gadget"))).toBe(false);
  });

  it("attributes a method's parameter type to the method (return is a Returns edge)", () => {
    expect(has(id("Factory.make"), id("Widget"))).toBe(true);
    expect(has(id("Factory.make"), id("Gadget"))).toBe(false);
  });

  it("attributes a property's type to the property node, not the enclosing class", () => {
    // Properties are now their own nodes, so the UsesType edge sits on the
    // property — `Holder.item` → `Widget` — and no longer on the class.
    expect(result.nodes.find((n) => n.id === id("Holder.item"))?.kind).toBe("Property");
    expect(has(id("Holder.item"), id("Widget"))).toBe(true);
    expect(has(id("Holder"), id("Widget"))).toBe(false);
  });

  it("finds type references nested inside composite annotations", () => {
    expect(has(id("many"), id("Widget"))).toBe(true);
  });

  it("emits no UsesType edge for a purely primitive signature", () => {
    expect(usesType().some((e) => e.from === id("plain"))).toBe(false);
  });

  it("a File node's range spans the whole file, including the leading comment", () => {
    // usetype.ts opens with a comment block; the File node must start at line 1
    // (not the first token) so get_code_snippet returns the full file.
    const file = result.nodes.find((n) => n.kind === "File");
    expect(file?.range?.startLine).toBe(1);
  });
});
