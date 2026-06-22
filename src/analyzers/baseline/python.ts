import * as path from "node:path";
import type Parser from "web-tree-sitter";
import { type GraphEdge, type GraphNode, symbolId } from "../../graph/index.js";
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

/** Flask/FastAPI HTTP-verb decorator attributes (`@app.get(...)`); `route` is handled
 *  separately as Flask's any-/default-GET form. (ama-bvg) */
const ROUTE_METHOD_ATTRS = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);

/** Normalize a framework route path to the `:param` form — Flask `<id>`/`<int:id>` and
 *  FastAPI `{id}` both become `:id` — and ensure a leading slash. (ama-bvg) */
function normalizeRoutePath(p: string): string {
  const s = p.replace(/<(?:[^:>]+:)?([^>]+)>/g, ":$1").replace(/\{([^}]+)\}/g, ":$1");
  return s.startsWith("/") ? s : `/${s}`;
}

/** The first string-literal argument of a call's `arguments`, unquoted. */
function firstStringArg(args: Parser.SyntaxNode | null): string | undefined {
  if (!args) return undefined;
  for (const a of args.namedChildren) {
    if (a.type === "string") return a.namedChildren.find((c) => c.type === "string_content")?.text;
  }
  return undefined;
}

/** Method + normalized path for a Flask/FastAPI route decorator, else undefined. `@x.route(p)`
 *  → GET (Flask default; the `methods=` kwarg is a later refinement); `@x.get(p)` etc. take the
 *  verb from the attribute name. (ama-bvg) */
function routeFromDecorator(dec: Parser.SyntaxNode): { method: string; path: string } | undefined {
  const call = dec.namedChildren.find((c) => c.type === "call");
  const fn = call?.childForFieldName("function");
  if (!call || fn?.type !== "attribute") return undefined;
  const attr = fn.childForFieldName("attribute")?.text?.toLowerCase();
  if (!attr || (attr !== "route" && !ROUTE_METHOD_ATTRS.has(attr))) return undefined;
  const raw = firstStringArg(call.childForFieldName("arguments"));
  if (raw === undefined) return undefined;
  return { method: attr === "route" ? "GET" : attr.toUpperCase(), path: normalizeRoutePath(raw) };
}

/** The handler's qualified name, matching walkSymbols' nesting: prepend each enclosing
 *  class/function name (a class method is `Class.method`; a top-level def is just its name). */
function qualifiedNameOf(fn: Parser.SyntaxNode): string | undefined {
  const own = fn.childForFieldName("name")?.text;
  if (!own) return undefined;
  const parts: string[] = [];
  for (let p = fn.parent; p; p = p.parent) {
    if (p.type === "class_definition" || p.type === "function_definition") {
      const n = p.childForFieldName("name")?.text;
      if (n) parts.unshift(n);
    }
  }
  parts.push(own);
  return parts.join(".");
}

function* eachDecorated(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  if (node.type === "decorated_definition") yield node;
  for (const c of node.namedChildren) yield* eachDecorated(c);
}

/** Detect Flask/FastAPI routes: a decorated function whose decorator is `@<obj>.route(path)`
 *  or `@<obj>.<verb>(path)` becomes a `METHOD /path` Route referencing the function. (ama-bvg) */
function pythonRoutes(
  root: Parser.SyntaxNode,
  rel: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const dd of eachDecorated(root)) {
    const fn = dd.childForFieldName("definition");
    if (fn?.type !== "function_definition") continue;
    const handler = qualifiedNameOf(fn);
    if (!handler) continue;
    for (const dec of dd.namedChildren) {
      if (dec.type !== "decorator") continue;
      const route = routeFromDecorator(dec);
      if (!route) continue;
      const name = `${route.method} ${route.path}`;
      const routeId = symbolId({ file: rel, qualifiedName: name });
      nodes.push({
        id: routeId,
        kind: "Route",
        name,
        file: rel,
        qualifiedName: name,
        tier: "baseline",
        range: { startLine: fn.startPosition.row + 1, endLine: fn.endPosition.row + 1 },
      });
      edges.push({
        from: routeId,
        to: symbolId({ file: rel, qualifiedName: handler }),
        kind: "References",
        provenance: "heuristic",
      });
    }
  }
  return { nodes, edges };
}

/** Django URL-pattern functions in `urls.py`. */
const DJANGO_URL_FUNCS = new Set(["path", "re_path"]);

function* eachCall(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  if (node.type === "call") yield node;
  for (const c of node.namedChildren) yield* eachCall(c);
}

/** Detect Django URL patterns: `path("users/<int:pk>/", view)` / `re_path(...)` in urls.py —
 *  method-agnostic (the view handles every verb), so each forms an `ANY /path` Route. The view
 *  is a cross-module reference (`views.foo`), not a same-file symbol, so no handler edge. (ama-a2r) */
function djangoUrlRoutes(
  root: Parser.SyntaxNode,
  rel: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  for (const call of eachCall(root)) {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "identifier" || !DJANGO_URL_FUNCS.has(fn.text)) continue;
    const raw = firstStringArg(call.childForFieldName("arguments"));
    if (raw === undefined) continue;
    const name = `ANY ${normalizeRoutePath(raw)}`;
    nodes.push({
      id: symbolId({ file: rel, qualifiedName: name }),
      kind: "Route",
      name,
      file: rel,
      qualifiedName: name,
      tier: "baseline",
      range: { startLine: call.startPosition.row + 1, endLine: call.endPosition.row + 1 },
    });
  }
  return { nodes, edges: [] };
}

/** Python route detection across shapes: Flask/FastAPI decorators + Django urls.py `path()`. */
function pythonRoutesAll(
  root: Parser.SyntaxNode,
  rel: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const decorated = pythonRoutes(root, rel);
  const django = djangoUrlRoutes(root, rel);
  return {
    nodes: [...decorated.nodes, ...django.nodes],
    edges: [...decorated.edges, ...django.edges],
  };
}

/** The nearest enclosing `function_definition` of a node, or undefined (module-level). */
function enclosingFunction(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "function_definition") return p;
  }
  return undefined;
}

function* eachFunction(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  if (node.type === "function_definition") yield node;
  for (const c of node.namedChildren) yield* eachFunction(c);
}

/** The simple (last-segment) name a call targets: `foo()` → "foo", `obj.bar()` → "bar". */
function calleeName(call: Parser.SyntaxNode): string | undefined {
  const fn = call.childForFieldName("function");
  if (fn?.type === "identifier") return fn.text;
  if (fn?.type === "attribute") return fn.childForFieldName("attribute")?.text;
  return undefined;
}

/** Heuristic within-file call edges (baseline tier): resolve each call's callee name to a
 *  function/method defined in the SAME file and emit a Calls edge from the enclosing function.
 *  Name-based (no types); a name defined more than once in the file is left unresolved to avoid
 *  wrong edges, and module-level calls (no enclosing function) are skipped. Cross-file
 *  resolution is a follow-up. (ama-bnj) */
function pythonCalls(
  root: Parser.SyntaxNode,
  rel: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byName = new Map<string, string | null>(); // simple name → id, or null when ambiguous
  for (const fn of eachFunction(root)) {
    const qn = qualifiedNameOf(fn);
    if (!qn) continue;
    const simple = qn.slice(qn.lastIndexOf(".") + 1);
    byName.set(simple, byName.has(simple) ? null : symbolId({ file: rel, qualifiedName: qn }));
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const call of eachCall(root)) {
    const enc = enclosingFunction(call);
    const name = calleeName(call);
    if (!enc || !name) continue;
    const to = byName.get(name);
    const callerQn = qualifiedNameOf(enc);
    if (!to || !callerQn) continue; // callee not defined in this file, or an ambiguous name
    const from = symbolId({ file: rel, qualifiedName: callerQn });
    const key = `${from} ${to}`;
    if (from === to || seen.has(key)) continue; // skip self-recursion + duplicate call sites
    seen.add(key);
    edges.push({ from, to, kind: "Calls", provenance: "heuristic" });
  }
  return { nodes: [], edges };
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
  collectRoutes: pythonRoutesAll,
  collectCalls: pythonCalls,
};
