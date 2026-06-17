import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer, type LanguageSpec } from "../../../src/analyzers/baseline/analyzer.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import { fileId, symbolId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/py-basic");

// A minimal Python spec — the real one (with imports etc.) is the Python
// baseline analyzer (s8q.3); this proves the generic framework.
const PYTHON: LanguageSpec = {
  language: "python",
  extensions: [".py"],
  grammar: "python",
  symbols: {
    function_definition: { kind: "Function" },
    class_definition: { kind: "Class" },
  },
};

const sym = (qualifiedName: string) => symbolId({ file: "sample.py", qualifiedName });

describe("BaselineAnalyzer", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(PYTHON).analyze(root, ["sample.py"]);
  });

  it("declares the baseline tier and the spec's language/extensions", () => {
    const analyzer = new BaselineAnalyzer(PYTHON);
    expect(analyzer.tier).toBe("baseline");
    expect(analyzer.language).toBe("python");
    expect(analyzer.extensions).toEqual([".py"]);
  });

  it("emits a File node for the source file", () => {
    expect(result.nodes.find((n) => n.id === fileId("sample.py"))?.kind).toBe("File");
  });

  it("emits top-level function and class nodes at the baseline tier", () => {
    const greet = result.nodes.find((n) => n.qualifiedName === "greet");
    expect(greet?.kind).toBe("Function");
    expect(greet?.tier).toBe("baseline");
    expect(result.nodes.find((n) => n.qualifiedName === "Greeter")?.kind).toBe("Class");
  });

  it("qualifies nested symbols and links them with Defines edges", () => {
    // A method `def hello` inside `class Greeter` is qualified under the class.
    expect(result.nodes.find((n) => n.qualifiedName === "Greeter.hello")?.kind).toBe("Function");
    // File defines the top-level function…
    expect(
      result.edges.some(
        (e) => e.kind === "Defines" && e.from === fileId("sample.py") && e.to === sym("greet"),
      ),
    ).toBe(true);
    // …and the class defines its method.
    expect(
      result.edges.some(
        (e) => e.kind === "Defines" && e.from === sym("Greeter") && e.to === sym("Greeter.hello"),
      ),
    ).toBe(true);
  });
});
