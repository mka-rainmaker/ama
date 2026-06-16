import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-basic");

describe("TypeScriptAnalyzer", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["sample.ts"]);
  });

  it("emits a File node keyed by the repo-relative path", () => {
    const file = result.nodes.find((n) => n.kind === "File");
    expect(file?.file).toBe("sample.ts");
    expect(file?.id).toBe("sample.ts");
  });

  it("emits a Function node for a top-level function", () => {
    const fn = result.nodes.find((n) => n.kind === "Function" && n.name === "greet");
    expect(fn).toBeDefined();
    expect(fn?.qualifiedName).toBe("greet");
  });

  it("emits a Class node and its Method with a dotted qualified name", () => {
    const cls = result.nodes.find((n) => n.kind === "Class" && n.name === "Greeter");
    const method = result.nodes.find((n) => n.kind === "Method");
    expect(cls).toBeDefined();
    expect(method?.name).toBe("greet");
    expect(method?.qualifiedName).toBe("Greeter.greet");
  });

  it("gives the function and the method distinct ids despite sharing a name", () => {
    const fn = result.nodes.find((n) => n.kind === "Function");
    const method = result.nodes.find((n) => n.kind === "Method");
    expect(fn).toBeDefined();
    expect(method).toBeDefined();
    expect(fn?.id).not.toBe(method?.id);
  });

  it("links containers to members with Defines edges", () => {
    const cls = result.nodes.find((n) => n.kind === "Class");
    const method = result.nodes.find((n) => n.kind === "Method");
    expect(cls).toBeDefined();
    expect(method).toBeDefined();
    const defines = result.edges.filter((e) => e.kind === "Defines");
    expect(defines.some((e) => e.from === "sample.ts" && e.to === cls?.id)).toBe(true);
    expect(defines.some((e) => e.from === cls?.id && e.to === method?.id)).toBe(true);
  });

  it("attributes every node to the deep tier", () => {
    expect(result.nodes.every((n) => n.tier === "deep")).toBe(true);
  });

  it("records a source range for snippet extraction", () => {
    const fn = result.nodes.find((n) => n.kind === "Function");
    expect(fn?.range?.startLine).toBe(1);
    expect(fn?.range?.endLine).toBeGreaterThanOrEqual(1);
  });
});
