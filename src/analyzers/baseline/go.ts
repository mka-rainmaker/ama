import * as fs from "node:fs";
import * as path from "node:path";
import type Parser from "web-tree-sitter";
import type { LanguageSpec } from "./analyzer.js";

/** Cache: an importer's directory (absolute) → its nearest `go.mod`'s repo-relative
 *  directory and module path, or null if none up to the index root. Memoized so a
 *  package isn't re-walked per import. */
const goModuleCache = new Map<string, { dir: string; module: string } | null>();

function parentDir(rel: string): string {
  const p = path.posix.dirname(rel);
  return p === "." ? "" : p;
}

/** The nearest `go.mod` at or above `dirRel`, with its repo-relative directory and
 *  declared module path — so Go imports resolve whether the index root *is* the
 *  module or merely contains it (a monorepo / Ama's own fixture). (ama-9yu) */
function nearestGoModule(root: string, dirRel: string): { dir: string; module: string } | null {
  const absDir = path.join(root, dirRel);
  const cached = goModuleCache.get(absDir);
  if (cached !== undefined) return cached;
  let result: { dir: string; module: string } | null = null;
  try {
    const module = fs
      .readFileSync(path.join(absDir, "go.mod"), "utf8")
      .match(/^module\s+(\S+)/m)?.[1];
    if (module) result = { dir: dirRel, module };
  } catch {
    result = null; // no go.mod here — try the parent below
  }
  if (!result && dirRel !== "" && dirRel !== ".") {
    result = nearestGoModule(root, parentDir(dirRel));
  }
  goModuleCache.set(absDir, result);
  return result;
}

/** Resolve a Go import to the `.go` files of its package directory. Go imports a
 *  *package* (a directory), so the import links to every non-test `.go` file in it.
 *  The import path is module-qualified (`<module>/<pkg>`); strip the module prefix
 *  (from the nearest `go.mod`) to get the directory, relative to that `go.mod`.
 *  Stdlib and third-party imports don't match the module, so they resolve to
 *  nothing. (ama-9yu) */
function goImports(
  node: Parser.SyntaxNode,
  importerRel: string,
  root: string,
): string[][] | undefined {
  if (node.type !== "import_spec") return undefined;
  const str = node.namedChildren.find((c) => c.type === "interpreted_string_literal");
  if (!str) return [];
  const importPath = str.text.replace(/^["`]|["`]$/g, "");
  const mod = nearestGoModule(root, parentDir(importerRel));
  if (!mod || (importPath !== mod.module && !importPath.startsWith(`${mod.module}/`))) return [];
  const sub = importPath === mod.module ? "" : importPath.slice(mod.module.length + 1);
  const pkgDir = [mod.dir, sub].filter(Boolean).join("/");
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(root, pkgDir));
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
    .map((f) => [pkgDir ? `${pkgDir}/${f}` : f]);
}

/**
 * Baseline (syntactic) spec for Go. Go declares named types with a single
 * `type_spec` node regardless of whether the body is a struct, interface, or
 * alias — so it uses {@link SymbolRule.kindByChild} to refine: a `struct_type`
 * child → Class, an `interface_type` child → Interface, else a TypeAlias.
 * Methods are top-level `method_declaration`s (the receiver isn't a container),
 * so they surface as Methods named for the function, not qualified by the type.
 */
export const goSpec: LanguageSpec = {
  language: "go",
  extensions: [".go"],
  grammar: "go",
  symbols: {
    function_declaration: { kind: "Function" },
    method_declaration: { kind: "Method" },
    type_spec: {
      kind: "TypeAlias",
      kindByChild: { struct_type: "Class", interface_type: "Interface" },
    },
  },
  resolveImports: goImports,
};
