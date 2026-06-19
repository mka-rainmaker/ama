import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-components");
const id = (qualifiedName: string) => symbolId({ file: "comp.tsx", qualifiedName });

describe("TypeScriptAnalyzer component nodes + hook usage (ama-rme.9)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["comp.tsx"]);
  });

  const node = (kind: string, qualifiedName: string) =>
    result.nodes.find((n) => n.kind === kind && n.qualifiedName === qualifiedName);

  it("marks a JSX-returning PascalCase function as a Component", () => {
    expect(node("Component", "Button")).toBeDefined();
    expect(node("Function", "Button")).toBeUndefined();
  });

  it("marks a Vue defineComponent() binding as a Component", () => {
    expect(node("Component", "Counter")).toBeDefined();
  });

  it("leaves a custom hook and a plain helper as Functions, not Components", () => {
    expect(node("Function", "useCounter")).toBeDefined();
    expect(node("Function", "helper")).toBeDefined();
    expect(node("Component", "useCounter")).toBeUndefined();
  });

  it("captures hook usage as a Calls edge from the component to the custom hook", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "Calls" && e.from === id("Button") && e.to === id("useCounter"),
      ),
    ).toBe(true);
  });
});
