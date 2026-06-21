import * as path from "node:path";
import type Parser from "web-tree-sitter";
import type { LanguageSpec } from "./analyzer.js";

/** Resolve a C/C++ `#include "foo.h"` to its header file. The quoted form is
 *  relative to the including file's directory (and resolved on disk, like JS/Python
 *  relative imports), so it's single-file-reindex-safe; the angle form `#include <…>`
 *  is a system/include-path header (external) and resolves to nothing. (ama-ftg) */
function includeImports(node: Parser.SyntaxNode, importerRel: string): string[][] | undefined {
  if (node.type !== "preproc_include") return undefined;
  const lit = node.namedChildren.find((c) => c.type === "string_literal");
  if (!lit) return []; // `#include <…>` (system_lib_string) — external
  const content = lit.namedChildren.find((c) => c.type === "string_content");
  const includePath = (content?.text ?? lit.text.replace(/^"|"$/g, "")).trim();
  if (!includePath) return [];
  // join() normalizes `..`, so `#include "../inc/x.h"` from `src/a.c` → `inc/x.h`.
  return [[path.posix.join(path.posix.dirname(importerRel), includePath)]];
}

/**
 * Baseline (syntactic) specs for C and C++. Both share a grammar family: structs,
 * unions, enums, and typedefs carry a `name` field, while a `function_definition`
 * nests its name in a `declarator` chain — the analyzer's `symbolName` drills that
 * for us. C++ adds classes and namespaces; a method defined inline is a
 * `function_definition` inside the class body, so it surfaces as a Function
 * qualified under its class (e.g. `Sample.square`). (ama-s8q.9)
 */
export const cSpec: LanguageSpec = {
  language: "c",
  extensions: [".c"],
  grammar: "c",
  symbols: {
    function_definition: { kind: "Function" },
    struct_specifier: { kind: "Class" },
    union_specifier: { kind: "Class" },
    enum_specifier: { kind: "Enum" },
    type_definition: { kind: "TypeAlias" },
  },
  resolveImports: includeImports,
};

export const cppSpec: LanguageSpec = {
  language: "cpp",
  // `.h` routes here: the C++ grammar is a superset, so it parses C headers too.
  extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".h"],
  grammar: "cpp",
  symbols: {
    function_definition: { kind: "Function" },
    struct_specifier: { kind: "Class" },
    union_specifier: { kind: "Class" },
    enum_specifier: { kind: "Enum" },
    type_definition: { kind: "TypeAlias" },
    class_specifier: { kind: "Class" },
    namespace_definition: { kind: "Module" },
  },
  resolveImports: includeImports,
};
