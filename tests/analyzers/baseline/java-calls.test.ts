import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { javaSpec } from "../../../src/analyzers/baseline/java.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import { type GraphEdge, deriveCallEdges, symbolId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/java-calls");

/**
 * Baseline-tier heuristic call edges for Java (slice 1: within-file). A method call resolves to a
 * method defined in the SAME file by name, emitting a Calls edge from the enclosing method — so
 * find_callers/find_callees stop being empty (callsTotal: 0) for Java same-class relationships. (#34) */
describe("Java within-file call edges (#34)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(javaSpec).analyze(root, ["Sample.java"]);
  });

  const calls = (from: string, to: string) =>
    result.edges.some(
      (e) =>
        e.kind === "Calls" &&
        e.from === symbolId({ file: "Sample.java", qualifiedName: from }) &&
        e.to === symbolId({ file: "Sample.java", qualifiedName: to }),
    );

  it("links a method to a same-file method it calls", () => {
    expect(calls("Sample.square", "Sample.mul")).toBe(true);
  });

  it("skips self-recursion", () => {
    expect(calls("Sample.recurse", "Sample.recurse")).toBe(false);
  });

  it("does not invent an outgoing call from a leaf method", () => {
    expect(
      result.edges.some(
        (e) =>
          e.kind === "Calls" &&
          e.from === symbolId({ file: "Sample.java", qualifiedName: "Sample.mul" }),
      ),
    ).toBe(false);
  });
});

/**
 * Slice 2: a call to a method NOT defined in the file becomes a `call:<name>` candidate that
 * deriveCallEdges resolves whole-graph to a method in an imported file (`Caller` imports
 * `com.util.Helper` and calls `Helper.help`) — so Java callers/callees span files, not just classes. */
describe("Java cross-file call edges (#34, slice 2)", () => {
  const xroot = path.resolve(here, "../../fixtures/java-calls-xfile");
  let edges: GraphEdge[];
  beforeAll(async () => {
    const result = await new BaselineAnalyzer(javaSpec).analyze(xroot, [
      "com/app/Caller.java",
      "com/util/Helper.java",
    ]);
    // The deriver resolves `call:<name>` candidates whole-graph via the import edges — the same
    // pass relinkCalls runs in the indexer after every file is analyzed.
    edges = [...result.edges, ...deriveCallEdges(result.nodes, result.edges)];
  });

  it("resolves a call to an imported class's method via the import graph", () => {
    expect(
      edges.some(
        (e) =>
          e.kind === "Calls" &&
          e.from === symbolId({ file: "com/app/Caller.java", qualifiedName: "Caller.run" }) &&
          e.to === symbolId({ file: "com/util/Helper.java", qualifiedName: "Helper.help" }),
      ),
    ).toBe(true);
  });
});
