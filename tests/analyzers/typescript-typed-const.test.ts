import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-typed-const");

/**
 * A `const x: T = { … }` (object-literal initializer) used to be invisible: the
 * analyzer recursed into the object's members but emitted no node for `x` and never
 * keyed it in declToId, so its `: T` annotation reached collectTypeUsages with no
 * owner and the UsesType edge was dropped — find_type_users(T)/impact_analysis(T)
 * missed every typed object const (e.g. all the baseline `LanguageSpec` specs). A
 * *typed* object const is a named, typed symbol worth a node; an *untyped* one stays
 * node-less (no node per anonymous config). (ama-g73)
 */
describe("TypeScriptAnalyzer typed object-literal const (ama-g73)", () => {
  const result = new TypeScriptAnalyzer().analyze(root, ["types.ts", "spec.ts"]);
  const widget = symbolId({ file: "spec.ts", qualifiedName: "widget" });
  const widgetType = symbolId({ file: "types.ts", qualifiedName: "Widget" });
  const config = symbolId({ file: "spec.ts", qualifiedName: "config" });

  it("emits a queryable Variable node for the typed object const", () => {
    expect(result.nodes.some((n) => n.id === widget && n.kind === "Variable")).toBe(true);
  });

  it("links the const to its declared type via UsesType", () => {
    expect(
      result.edges.some((e) => e.from === widget && e.to === widgetType && e.kind === "UsesType"),
    ).toBe(true);
  });

  it("leaves an untyped object literal node-less", () => {
    expect(result.nodes.some((n) => n.id === config)).toBe(false);
  });
});
