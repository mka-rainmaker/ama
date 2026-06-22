import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { pythonSpec } from "../../../src/analyzers/baseline/python.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import { symbolId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/py-calls");

/**
 * Baseline-tier heuristic call edges for Python: a call resolves to a function/method defined in
 * the same file, emitting a Calls edge from the enclosing function — so find_callers/find_callees
 * stop being empty for same-module relationships (helper functions, self-methods). (ama-bnj) */
describe("Python within-file call edges (ama-bnj)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(pythonSpec).analyze(root, ["handlers.py"]);
  });

  const calls = (from: string, to: string) =>
    result.edges.some(
      (e) =>
        e.kind === "Calls" &&
        e.from === symbolId({ file: "handlers.py", qualifiedName: from }) &&
        e.to === symbolId({ file: "handlers.py", qualifiedName: to }),
    );

  it("links a function to a same-file helper it calls", () => {
    expect(calls("handler", "helper")).toBe(true);
  });

  it("links a method to a sibling method via self", () => {
    expect(calls("Service.run", "Service.compute")).toBe(true);
  });

  it("does not invent calls to undefined names", () => {
    // `helper` calls nothing; no outgoing Calls edge from it.
    expect(
      result.edges.some(
        (e) =>
          e.kind === "Calls" &&
          e.from === symbolId({ file: "handlers.py", qualifiedName: "helper" }),
      ),
    ).toBe(false);
  });
});
