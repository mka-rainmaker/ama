import * as path from "node:path";
import type Parser from "web-tree-sitter";
import { type GraphEdge, type GraphNode, symbolId } from "../../graph/index.js";
import type { LanguageSpec } from "./analyzer.js";

/** Files whose `mod foo;` submodules live in the *same* directory (a crate root
 *  or a `mod.rs`); any other `foo.rs` owns a `foo/` directory for its submodules. */
const RUST_DIR_MODULES = new Set(["mod", "lib", "main"]);

/** Resolve a Rust `mod foo;` file-module declaration to candidate files. An inline
 *  `mod foo { … }` has a `declaration_list` body and declares no file. A submodule
 *  sits beside the declaring file, except a non-`mod.rs`/`lib.rs`/`main.rs` file
 *  owns a directory named after its stem (Rust 2018) — so `mod bar;` in `a/foo.rs`
 *  is `a/foo/bar.rs`. `use` imports items, not files, and is skipped. (ama-90x) */
function rustImports(node: Parser.SyntaxNode, importerRel: string): string[][] | undefined {
  if (node.type !== "mod_item") return undefined;
  if (node.namedChildren.some((c) => c.type === "declaration_list")) return []; // inline module
  const name = node.childForFieldName("name")?.text;
  if (!name) return undefined;
  const stem = path.posix.basename(importerRel, ".rs");
  const dir = path.posix.dirname(importerRel);
  const baseDir = RUST_DIR_MODULES.has(stem) ? dir : path.posix.join(dir, stem);
  const base = baseDir === "." ? name : `${baseDir}/${name}`;
  return [[`${base}.rs`, `${base}/mod.rs`]];
}

/** actix-web route attribute macros — `#[get("/x")]` — by macro name → HTTP verb. (ama-a2r) */
const RUST_ROUTE_VERBS = new Map([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["delete", "DELETE"],
  ["patch", "PATCH"],
  ["head", "HEAD"],
]);

function firstOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
  if (node.type === type) return node;
  for (const c of node.namedChildren) {
    const found = firstOfType(c, type);
    if (found) return found;
  }
  return undefined;
}

/** Normalize an actix route path: `{id}` → `:id`; ensure a leading slash. (ama-a2r) */
function normalizeRustRoutePath(p: string): string {
  const s = p.replace(/\{([^}]+)\}/g, ":$1");
  return s.startsWith("/") ? s : `/${s}`;
}

/** A route `{verb, path}` among the `attribute_item`s immediately preceding `siblings[fnIndex]`
 *  (a function_item), or undefined — `#[get("/x")]` → `attribute` (`get` + a string token). */
function rustRouteFromAttrs(
  siblings: Parser.SyntaxNode[],
  fnIndex: number,
): { verb: string; path: string } | undefined {
  for (let j = fnIndex - 1; j >= 0 && siblings[j]?.type === "attribute_item"; j--) {
    const attr = siblings[j]?.namedChildren.find((c) => c.type === "attribute");
    if (!attr) continue;
    const verb = RUST_ROUTE_VERBS.get(firstOfType(attr, "identifier")?.text ?? "");
    const str = firstOfType(attr, "string_literal");
    if (verb && str) return { verb, path: str.text.replace(/^"|"$/g, "") };
  }
  return undefined;
}

/** Detect actix-web routes: a `#[get("/x")]`-style attribute on a `fn` becomes a `METHOD /x`
 *  Route referencing the function. Recurses so functions inside `mod` blocks are covered. (ama-a2r) */
function rustRoutes(
  root: Parser.SyntaxNode,
  rel: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    const kids = node.namedChildren;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (!k) continue;
      if (k.type === "function_item") {
        const route = rustRouteFromAttrs(kids, i);
        const fnName = k.childForFieldName("name")?.text;
        if (route && fnName) {
          const name = `${route.verb} ${normalizeRustRoutePath(route.path)}`;
          const routeId = symbolId({ file: rel, qualifiedName: name });
          nodes.push({
            id: routeId,
            kind: "Route",
            name,
            file: rel,
            qualifiedName: name,
            tier: "baseline",
            range: { startLine: k.startPosition.row + 1, endLine: k.endPosition.row + 1 },
          });
          edges.push({
            from: routeId,
            to: symbolId({ file: rel, qualifiedName: fnName }),
            kind: "References",
            provenance: "heuristic",
          });
        }
      }
      visit(k);
    }
  };
  visit(root);
  return { nodes, edges };
}

/**
 * Baseline (syntactic) spec for Rust. Rust gives each kind its own node type, so
 * the plain map suffices: struct → Class, enum → Enum, trait → Interface, fn →
 * Function. Trait methods nest under the trait (`Shape.area`); methods defined
 * in separate `impl` blocks are top-level `function_item`s (the impl isn't a
 * container), so they surface unqualified — acceptable for a syntactic tier.
 */
export const rustSpec: LanguageSpec = {
  language: "rust",
  extensions: [".rs"],
  grammar: "rust",
  symbols: {
    function_item: { kind: "Function" },
    // A bodyless fn (trait method declaration, extern block) is a signature item.
    function_signature_item: { kind: "Function" },
    struct_item: { kind: "Class" },
    enum_item: { kind: "Enum" },
    trait_item: { kind: "Interface" },
  },
  resolveImports: rustImports,
  collectRoutes: rustRoutes,
};
