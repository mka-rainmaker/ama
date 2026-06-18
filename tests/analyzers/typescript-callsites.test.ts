import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-multicall");
const id = (qualifiedName: string) => symbolId({ file: "multi.ts", qualifiedName });

describe("TypeScriptAnalyzer per-call-site accumulation (ama-hft.10)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["multi.ts"]);
  });

  const callEdge = () =>
    result.edges.find(
      (e) => e.kind === "Calls" && e.from === id("caller") && e.to === id("target"),
    );

  it("collapses repeated calls to one edge", () => {
    expect(result.edges.filter((e) => e.kind === "Calls" && e.from === id("caller"))).toHaveLength(
      1,
    );
  });

  it("records every call site on that edge", () => {
    const sites = callEdge()?.sites;
    expect(sites).toHaveLength(2);
    // The two `target()` calls are on consecutive lines; the first stays as `at`.
    expect(sites?.[0]).toEqual(callEdge()?.at);
    expect(sites?.[0]?.line).not.toBe(sites?.[1]?.line);
  });
});
