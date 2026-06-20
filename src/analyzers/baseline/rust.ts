import * as path from "node:path";
import type Parser from "web-tree-sitter";
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
};
