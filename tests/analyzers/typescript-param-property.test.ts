import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-param-prop");
const sym = (qualifiedName: string) => symbolId({ file: "sample.ts", qualifiedName });

/**
 * A constructor parameter property (`constructor(private readonly x: T)`) is a real
 * class member, but the analyzer modelled only class-body members + the constructor
 * itself — so those members were invisible to node()/find_referrers/file_skeleton.
 * Each parameter carrying an accessibility/readonly modifier should become a Property
 * node under its class; a plain parameter (no modifier) should not. (ama-259)
 */
describe("TypeScriptAnalyzer constructor parameter properties (ama-259)", () => {
  const result = new TypeScriptAnalyzer().analyze(root, ["sample.ts"]);
  const isProperty = (qn: string) =>
    result.nodes.some((n) => n.id === sym(qn) && n.kind === "Property");

  it("emits a Property node for each parameter property", () => {
    expect(isProperty("Service.dep")).toBe(true); // private readonly
    expect(isProperty("Service.name")).toBe(true); // public
  });

  it("leaves a plain (unmodified) constructor parameter node-less", () => {
    expect(result.nodes.some((n) => n.id === sym("Service.plain"))).toBe(false);
  });

  it("defines each parameter property on its class", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "Defines" && e.from === sym("Service") && e.to === sym("Service.dep"),
      ),
    ).toBe(true);
  });
});
