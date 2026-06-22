import * as fs from "node:fs";
import * as path from "node:path";
import type Parser from "web-tree-sitter";
import { type GraphEdge, type GraphNode, symbolId } from "../../graph/index.js";
import type { LanguageSpec } from "./analyzer.js";
import { nearestConfig, parentDir } from "./config.js";

/** Cache for the nearest `go.mod`'s declared module path, by importer directory. */
const goModuleCache = new Map<string, { dir: string; value: string } | null>();

/** The `module` path declared by a `go.mod` in `absDir`, or undefined if there's none. */
function readGoModule(absDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(absDir, "go.mod"), "utf8").match(/^module\s+(\S+)/m)?.[1];
  } catch {
    return undefined; // no go.mod here — nearestConfig walks to the parent
  }
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
  const mod = nearestConfig(root, parentDir(importerRel), readGoModule, goModuleCache);
  if (!mod || (importPath !== mod.value && !importPath.startsWith(`${mod.value}/`))) return [];
  const sub = importPath === mod.value ? "" : importPath.slice(mod.value.length + 1);
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

/** Gin/chi/echo HTTP-verb router methods — `r.GET("/x", h)`. (ama-a2r) */
const GO_ROUTE_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]);

/** Normalize a Go route path: chi/mux `{id}` → `:id` (Gin's `:id` is already the shared form);
 *  ensure a leading slash. (ama-a2r) */
function normalizeGoRoutePath(p: string): string {
  const s = p.replace(/\{([^}]+)\}/g, ":$1");
  return s.startsWith("/") ? s : `/${s}`;
}

/** The first string-literal argument (interpreted or raw) of an argument_list, unquoted. */
function goStringArg(args: Parser.SyntaxNode | null): string | undefined {
  if (!args) return undefined;
  for (const a of args.namedChildren) {
    if (a.type === "interpreted_string_literal" || a.type === "raw_string_literal") {
      return a.text.replace(/^[`"]|[`"]$/g, "");
    }
  }
  return undefined;
}

function* eachCall(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  if (node.type === "call_expression") yield node;
  for (const c of node.namedChildren) yield* eachCall(c);
}

/** Detect Gin/chi/echo-style routes: `r.GET("/path", handler)` — a call whose function is a
 *  selector with an HTTP-verb field and a string first arg — becomes a `METHOD /path` Route,
 *  referencing the handler when it's a plain identifier in the same file. (ama-a2r) */
function goRoutes(
  root: Parser.SyntaxNode,
  rel: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const call of eachCall(root)) {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") continue;
    const verb = fn.childForFieldName("field")?.text?.toUpperCase();
    if (!verb || !GO_ROUTE_METHODS.has(verb)) continue;
    const args = call.childForFieldName("arguments");
    const raw = goStringArg(args);
    if (raw === undefined) continue;
    const name = `${verb} ${normalizeGoRoutePath(raw)}`;
    const routeId = symbolId({ file: rel, qualifiedName: name });
    nodes.push({
      id: routeId,
      kind: "Route",
      name,
      file: rel,
      qualifiedName: name,
      tier: "baseline",
      range: { startLine: call.startPosition.row + 1, endLine: call.endPosition.row + 1 },
    });
    const handler = args?.namedChildren.find((a, i) => i > 0 && a.type === "identifier");
    if (handler) {
      edges.push({
        from: routeId,
        to: symbolId({ file: rel, qualifiedName: handler.text }),
        kind: "References",
        provenance: "heuristic",
      });
    }
  }
  return { nodes, edges };
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
  collectRoutes: goRoutes,
};
