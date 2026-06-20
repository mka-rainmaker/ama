import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { pythonSpec } from "../../../src/analyzers/baseline/python.js";
import { fileId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/py-imports");

/**
 * Baseline analyzers emit only File/symbol nodes today, so the import graph is
 * empty for every baseline language. Python relative imports resolve to a file
 * by path alone (no cross-file analysis), so the baseline tier can emit File→File
 * Imports edges — making find_importers / circular_imports work for Python. A
 * package/absolute import (`import os`) is external and emits nothing. (ama-8nr)
 */
describe("baseline Python import edges (ama-8nr)", () => {
  it("emits File→File Imports for relative imports, skipping absolute ones", async () => {
    const result = await new BaselineAnalyzer(pythonSpec).analyze(root, [
      "main.py",
      "helper.py",
      "pkg/__init__.py",
    ]);
    const imports = result.edges.filter(
      (e) => e.kind === "Imports" && e.from === fileId("main.py"),
    );
    // `from . import helper` → helper.py
    expect(imports.some((e) => e.to === fileId("helper.py"))).toBe(true);
    // `from .pkg import thing` → the pkg package's __init__.py
    expect(imports.some((e) => e.to === fileId("pkg/__init__.py"))).toBe(true);
    // `import os` is absolute/external — no edge to a node we can't back
    expect(imports.length).toBe(2);
  });
});
