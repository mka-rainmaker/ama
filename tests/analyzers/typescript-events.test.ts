import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-events");
const id = (qualifiedName: string) => symbolId({ file: "ev.ts", qualifiedName });

describe("TypeScriptAnalyzer EventEmitter on/emit synthesis (ama-hft.14)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["ev.ts"]);
  });

  const eventEdge = () =>
    result.edges.find(
      (e) => e.kind === "Calls" && e.from === id("Bus.publish") && e.to === id("handleData"),
    );

  it("synthesizes a Calls edge from an emitter to a same-channel listener", () => {
    expect(eventEdge()).toBeDefined();
  });

  it("marks the synthesized edge heuristic — channel match, not a proven call", () => {
    expect(eventEdge()?.provenance).toBe("heuristic");
  });
});
