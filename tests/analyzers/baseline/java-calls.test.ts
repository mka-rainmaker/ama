import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { javaSpec } from "../../../src/analyzers/baseline/java.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import {
  CALL_REF_PREFIX,
  type GraphEdge,
  deriveCallEdges,
  symbolId,
} from "../../../src/graph/index.js";

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

  it("skips ubiquitous stdlib names but keeps real same-file calls (#38)", () => {
    // `println` is a builtin → no cross-file `call:` candidate emitted (noise that never resolves)
    expect(
      result.edges.some((e) => e.provenance === "call-ref" && e.to === `${CALL_REF_PREFIX}println`),
    ).toBe(false);
    // the real same-file call in the same method still resolves
    expect(calls("Sample.log", "Sample.square")).toBe(true);
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

/**
 * Slice 3 (#34, failure mode #1): a call to a method on a SAME-PACKAGE sibling needs no `import`
 * in Java, so the import-guided resolver alone leaves it unresolved. Same-package resolution (a
 * candidate resolves against methods in the same directory) connects it — the dominant real-repo
 * case behind empty find_callers/find_callees. `Service.run` calls `Validator.check` with no import. */
describe("Java same-package call edges, no import (#34, slice 3)", () => {
  const sroot = path.resolve(here, "../../fixtures/java-calls-samepkg");
  let edges: GraphEdge[];
  beforeAll(async () => {
    const result = await new BaselineAnalyzer(javaSpec).analyze(sroot, [
      "com/app/Service.java",
      "com/app/Validator.java",
    ]);
    edges = [...result.edges, ...deriveCallEdges(result.nodes, result.edges)];
  });

  it("resolves a call to a same-package sibling's method without an import", () => {
    expect(
      edges.some(
        (e) =>
          e.kind === "Calls" &&
          e.from === symbolId({ file: "com/app/Service.java", qualifiedName: "Service.run" }) &&
          e.to === symbolId({ file: "com/app/Validator.java", qualifiedName: "Validator.check" }),
      ),
    ).toBe(true);
  });
});

/**
 * Pinning test for the documented cross-file overload behaviour (#41, #15 deep-tier limitation):
 * within-file, an overloaded simple name → null (ambiguous → skipped); cross-file, deriveCallEdges
 * uses first-definition-wins (funcsByFile Map), so a call to an overloaded method in an imported
 * file resolves to the FIRST definition in that file, not skipped. This test pins the actual
 * behaviour explicitly so any future change to resolution is caught and deliberate. */
describe("Java cross-file overloaded method: first-wins pinning test (#41, deep-tier #15)", () => {
  const oroot = path.resolve(here, "../../fixtures/java-calls-overload");
  let edges: GraphEdge[];
  beforeAll(async () => {
    const result = await new BaselineAnalyzer(javaSpec).analyze(oroot, [
      "com/app/Client.java",
      "com/util/Helper.java",
    ]);
    edges = [...result.edges, ...deriveCallEdges(result.nodes, result.edges)];
  });

  it("resolves a cross-file call to an overloaded method — first definition in the imported file wins", () => {
    // Helper.java defines `format(int)` first, then `format(String)`.
    // Baseline tier resolves Client.run → Helper.format(int) (the first definition), NOT skipped.
    const formatIntId = symbolId({
      file: "com/util/Helper.java",
      qualifiedName: "Helper.format",
    });
    expect(
      edges.some(
        (e) =>
          e.kind === "Calls" &&
          e.from === symbolId({ file: "com/app/Client.java", qualifiedName: "Client.run" }) &&
          e.to === formatIntId,
      ),
    ).toBe(true);
  });

  it("within-file: two overloads of the same simple name stay skipped (within-file remains ambiguous → null)", () => {
    // Helper.java has two `format` methods; within-file resolution marks the name null → no within-
    // file Calls edge from one format to the other.
    expect(
      edges.some(
        (e) =>
          e.kind === "Calls" &&
          e.from === symbolId({ file: "com/util/Helper.java", qualifiedName: "Helper.format" }),
      ),
    ).toBe(false);
  });
});
