import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-variable");
const id = (qualifiedName: string) => symbolId({ file: "consts.ts", qualifiedName });

describe("TypeScriptAnalyzer module-level variables (ama-hft.12)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["consts.ts"]);
  });

  it("emits a Variable node for a plain-valued const", () => {
    expect(result.nodes.find((n) => n.id === id("MAX_RETRIES"))?.kind).toBe("Variable");
  });

  it("emits a Variable node for a non-exported const and an `as const` value", () => {
    expect(result.nodes.find((n) => n.id === id("ROUTE_METHODS"))?.kind).toBe("Variable");
    expect(result.nodes.find((n) => n.id === id("LABELS"))?.kind).toBe("Variable");
  });

  it("links the file to each variable with a Defines edge", () => {
    const fileNode = result.nodes.find((n) => n.kind === "File");
    expect(
      result.edges.some(
        (e) => e.kind === "Defines" && e.from === fileNode?.id && e.to === id("MAX_RETRIES"),
      ),
    ).toBe(true);
  });

  it("does not turn a function-valued const into a Variable (stays Function)", () => {
    expect(result.nodes.find((n) => n.id === id("handler"))?.kind).toBe("Function");
  });

  it("preserves ama-zkr: an object-literal const is not a node, its members are Methods", () => {
    expect(result.nodes.some((n) => n.id === id("config"))).toBe(false);
    expect(result.nodes.find((n) => n.id === id("config.run"))?.kind).toBe("Method");
  });

  // ama-6k0: who reads a module-level variable.
  it("emits a References edge from a reader to each variable it reads", () => {
    for (const v of ["MAX_RETRIES", "ROUTE_METHODS", "LABELS"]) {
      expect(
        result.edges.some(
          (e) => e.kind === "References" && e.from === id("useThem") && e.to === id(v),
        ),
        `useThem should reference ${v}`,
      ).toBe(true);
    }
  });

  it("does not emit a self-reference for a variable's own declaration name", () => {
    expect(
      result.edges.some(
        (e) =>
          e.kind === "References" && e.from === id("MAX_RETRIES") && e.to === id("MAX_RETRIES"),
      ),
    ).toBe(false);
  });

  it("emits a UsesType edge from an annotated variable to its named type", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "UsesType" && e.from === id("TIMEOUT") && e.to === id("Millis"),
      ),
    ).toBe(true);
  });
});
