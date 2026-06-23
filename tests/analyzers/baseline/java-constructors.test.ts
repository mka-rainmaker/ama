import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { javaSpec } from "../../../src/analyzers/baseline/java.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import { type GraphEdge, deriveCallEdges, symbolId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/java-ctors");

/**
 * Slice 2 (S2-constructors): `constructor_declaration` becomes a Method node (qn `Class.Class`) and
 * `new Foo(...)` is a call site whose callee simple name is the constructed type, resolved within-file
 * by name or cross-file via the existing `call:` machinery. Overloaded ctors ambiguous by simple name
 * stay skipped — true disambiguation is deep-tier. (ama 0.4.0 S2) */
describe("Java constructor symbols + new() within-file (ama 0.4.0 S2)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(javaSpec).analyze(root, ["Local.java"]);
  });

  it("emits a Method node for a constructor (qn Class.Class)", () => {
    expect(
      result.nodes.some(
        (n) =>
          n.kind === "Method" &&
          n.id === symbolId({ file: "Local.java", qualifiedName: "Gadget.Gadget" }),
      ),
    ).toBe(true);
  });

  it("links `new Gadget()` to the same-file constructor", () => {
    expect(
      result.edges.some(
        (e) =>
          e.kind === "Calls" &&
          e.from === symbolId({ file: "Local.java", qualifiedName: "Factory.makeGadget" }) &&
          e.to === symbolId({ file: "Local.java", qualifiedName: "Gadget.Gadget" }),
      ),
    ).toBe(true);
  });

  it("skips an overloaded constructor (ambiguous by simple name)", () => {
    // `Widget` has two ctors → `new Widget(1)` cannot be disambiguated at baseline; no Calls edge.
    expect(
      result.edges.some(
        (e) =>
          e.kind === "Calls" &&
          e.from === symbolId({ file: "Local.java", qualifiedName: "Factory.makeWidget" }),
      ),
    ).toBe(false);
  });
});

/**
 * Cross-file: `new OrderService(repo)` in OrderController resolves to the OrderService constructor via
 * the same `call:<name>` import-graph machinery deriveCallEdges runs whole-store. */
describe("Java constructor call edges resolve cross-file (ama 0.4.0 S2)", () => {
  let edges: GraphEdge[];
  beforeAll(async () => {
    const result = await new BaselineAnalyzer(javaSpec).analyze(root, [
      "com/app/OrderController.java",
      "com/svc/OrderService.java",
      "com/repo/OrderRepository.java",
    ]);
    edges = [...result.edges, ...deriveCallEdges(result.nodes, result.edges)];
  });

  it("resolves `new OrderService(repo)` to the imported constructor", () => {
    expect(
      edges.some(
        (e) =>
          e.kind === "Calls" &&
          e.from ===
            symbolId({
              file: "com/app/OrderController.java",
              qualifiedName: "OrderController.wire",
            }) &&
          e.to ===
            symbolId({
              file: "com/svc/OrderService.java",
              qualifiedName: "OrderService.OrderService",
            }),
      ),
    ).toBe(true);
  });
});
