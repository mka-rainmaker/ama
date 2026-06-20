import * as path from "node:path";
import type Parser from "web-tree-sitter";
import type { LanguageSpec } from "./analyzer.js";

/**
 * Resolve a Python relative import (`from .x import y`, `from . import m`,
 * `from ..pkg import z`) to candidate repo-relative module files. The leading
 * dots count up from the importer's own package (one dot = its directory). An
 * absolute import (`import os`, `from pkg import x`) resolves via `sys.path` — too
 * ambiguous to back with a node — so it emits nothing. (ama-8nr)
 */
function pythonImports(node: Parser.SyntaxNode, importerRel: string): string[][] | undefined {
  if (node.type !== "import_from_statement") return undefined;
  const relative = node.namedChildren.find((c) => c.type === "relative_import");
  if (!relative) return []; // `from pkg import x` — absolute, unresolvable here
  const prefix = relative.namedChildren.find((c) => c.type === "import_prefix");
  const dots = prefix ? prefix.text.length : 1;
  // One dot = the importer's own package (its directory); each extra dot goes up.
  let base = path.posix.dirname(importerRel);
  for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
  if (base === ".") base = "";
  const candidates = (segments: string[]): string[] => {
    const p = [base, ...segments].filter(Boolean).join("/");
    return [`${p}.py`, `${p}/__init__.py`];
  };
  const segsOf = (dotted: Parser.SyntaxNode): string[] =>
    dotted.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text);
  const module = relative.namedChildren.find((c) => c.type === "dotted_name");
  if (module) return [candidates(segsOf(module))]; // `from .pkg.sub import x` → pkg/sub
  // `from . import a, b` — each imported name is a submodule of the base package.
  const groups: string[][] = [];
  for (const child of node.namedChildren) {
    if (child === relative) continue;
    if (child.type === "dotted_name") groups.push(candidates(segsOf(child)));
    else if (child.type === "aliased_import") {
      const dn = child.namedChildren.find((c) => c.type === "dotted_name");
      if (dn) groups.push(candidates(segsOf(dn)));
    }
  }
  return groups;
}

/**
 * Baseline (syntactic) spec for Python. Functions and classes are the symbols
 * worth a node; methods are `function_definition` too (Python doesn't
 * distinguish them syntactically), so they surface as Functions qualified under
 * their class (e.g. `Greeter.hello`). Decorated defs nest a `function_definition`
 * inside a `decorated_definition`, which the analyzer's recursion already reaches.
 */
export const pythonSpec: LanguageSpec = {
  language: "python",
  extensions: [".py"],
  grammar: "python",
  symbols: {
    function_definition: { kind: "Function" },
    class_definition: { kind: "Class" },
  },
  resolveImports: pythonImports,
};
