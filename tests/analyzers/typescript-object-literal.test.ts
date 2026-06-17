import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-object-literal");
const id = (qualifiedName: string) => symbolId({ file: "cmd.ts", qualifiedName });

describe("TypeScriptAnalyzer object-literal methods", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["cmd.ts"]);
  });

  it("emits a Method node for an object-literal method shorthand", () => {
    expect(result.nodes.find((n) => n.id === id("cmd.run"))?.kind).toBe("Method");
  });

  it("emits a Method node for a function-valued property", () => {
    expect(result.nodes.find((n) => n.id === id("cmd.handler"))?.kind).toBe("Method");
  });

  it("does not emit a node for a string-valued property", () => {
    expect(result.nodes.some((n) => n.id === id("cmd.name"))).toBe(false);
  });

  it("does not emit a node for the object-literal const itself", () => {
    expect(result.nodes.some((n) => n.id === id("cmd"))).toBe(false);
  });

  it("attributes a call inside a method shorthand to that method", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "Calls" && e.from === id("cmd.run") && e.to === id("target"),
      ),
    ).toBe(true);
  });

  it("attributes a call inside a function-valued property to that property", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "Calls" && e.from === id("cmd.handler") && e.to === id("target"),
      ),
    ).toBe(true);
  });
});
