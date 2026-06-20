import * as path from "node:path";
import type Parser from "web-tree-sitter";
import type { LanguageSpec } from "./analyzer.js";

/** Try a repo-relative file under every ancestor directory of the importer. A
 *  package import gives a *source-root-relative* path (`com/example/Foo.java`)
 *  but not the source root itself (`src/main/java`), which varies by build tool —
 *  so the correct root is simply whichever ancestor makes the file exist. Disk-
 *  based (via the analyzer's existsSync), so it's single-file-reindex-safe. */
function ancestorCandidates(importerRel: string, file: string): string[] {
  const candidates: string[] = [];
  let dir = path.posix.dirname(importerRel);
  while (true) {
    candidates.push(dir === "." ? file : `${dir}/${file}`);
    if (dir === "." || dir === "") break;
    dir = path.posix.dirname(dir);
  }
  return candidates;
}

/** Resolve a Java `import a.b.C;` to its class file. Java's convention (lowercase
 *  packages, PascalCase types) lets one rule cover regular, `static`, and nested
 *  imports: the class file is the dotted name up to and including the first
 *  PascalCase segment — trailing segments are a static member or a nested type,
 *  which live in that same file. `import a.b.*;` (wildcard) targets a package, not
 *  a file, and is skipped; an unresolved (JDK/dependency) import simply matches no
 *  file on disk. (ama-bsj) */
function javaImports(node: Parser.SyntaxNode, importerRel: string): string[][] | undefined {
  if (node.type !== "import_declaration") return undefined;
  if (node.namedChildren.some((c) => c.type === "asterisk")) return []; // wildcard import
  const scoped = node.namedChildren.find(
    (c) => c.type === "scoped_identifier" || c.type === "identifier",
  );
  if (!scoped) return [];
  const segments = scoped.text.split(".");
  const classEnd = segments.findIndex((s) => /^[A-Z]/.test(s));
  if (classEnd < 0) return []; // no PascalCase (type) segment — nothing to resolve
  const file = `${segments.slice(0, classEnd + 1).join("/")}.java`;
  return [ancestorCandidates(importerRel, file)];
}

/**
 * Baseline (syntactic) spec for Java. Java gives every kind its own CST node
 * type — class/interface/enum declarations and methods — so each maps directly
 * to the right graph kind, and methods (inside a class/interface body) qualify
 * cleanly under their type (e.g. `Sample.square`).
 */
export const javaSpec: LanguageSpec = {
  language: "java",
  extensions: [".java"],
  grammar: "java",
  symbols: {
    class_declaration: { kind: "Class" },
    interface_declaration: { kind: "Interface" },
    enum_declaration: { kind: "Enum" },
    method_declaration: { kind: "Method" },
  },
  resolveImports: javaImports,
};
