import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { javascriptSpec } from "../../../src/analyzers/baseline/javascript.js";
import { pythonSpec } from "../../../src/analyzers/baseline/python.js";
import { rustSpec } from "../../../src/analyzers/baseline/rust.js";
import { fileId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/py-imports");
const jsRoot = path.resolve(here, "../../fixtures/js-imports");
const rsRoot = path.resolve(here, "../../fixtures/rs-imports");

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

describe("baseline JavaScript import edges (ama-2dn)", () => {
  it("resolves relative import/export/require specifiers, skipping packages", async () => {
    const result = await new BaselineAnalyzer(javascriptSpec).analyze(jsRoot, [
      "main.js",
      "helper.js",
      "util.js",
      "cjs.cjs",
    ]);
    const imports = result.edges.filter(
      (e) => e.kind === "Imports" && e.from === fileId("main.js"),
    );
    // explicit extension, extensionless (try .js), and a require() call
    expect(imports.some((e) => e.to === fileId("helper.js"))).toBe(true);
    expect(imports.some((e) => e.to === fileId("util.js"))).toBe(true);
    expect(imports.some((e) => e.to === fileId("cjs.cjs"))).toBe(true);
    // `left-pad` is a bare package specifier — external, no edge
    expect(imports.length).toBe(3);
  });
});

describe("baseline Rust `mod` import edges (ama-90x)", () => {
  it("wires a file module to its file, honoring the foo.rs-owns-foo/ rule", async () => {
    const result = await new BaselineAnalyzer(rustSpec).analyze(rsRoot, [
      "lib.rs",
      "helper.rs",
      "sub.rs",
      "sub/deep.rs",
    ]);
    const from = (f: string) =>
      result.edges.filter((e) => e.kind === "Imports" && e.from === fileId(f));
    // crate root: `mod helper;` → helper.rs, `pub mod sub;` → sub.rs (same dir)
    expect(from("lib.rs").some((e) => e.to === fileId("helper.rs"))).toBe(true);
    expect(from("lib.rs").some((e) => e.to === fileId("sub.rs"))).toBe(true);
    // a non-mod.rs file owns a subdir: sub.rs's `mod deep;` → sub/deep.rs
    expect(from("sub.rs").some((e) => e.to === fileId("sub/deep.rs"))).toBe(true);
    // `use std::fmt;` is external — no edge (only `mod` declarations wire files)
    expect(from("lib.rs").length).toBe(2);
  });
});
