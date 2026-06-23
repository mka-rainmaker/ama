import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { javaSpec } from "../../../src/analyzers/baseline/java.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import { symbolId } from "../../../src/graph/index.js";

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
