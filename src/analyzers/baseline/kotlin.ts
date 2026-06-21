import * as fs from "node:fs";
import * as path from "node:path";
import type Parser from "web-tree-sitter";
import type { LanguageSpec } from "./analyzer.js";

/** Ancestor directories of a repo-relative file, closest first, ending at the repo
 *  root (""). (Mirrors csharp.ts; extracting a shared helper is filed as ama-mgn.) */
function ancestorDirs(rel: string): string[] {
  const dirs: string[] = [];
  let dir = path.posix.dirname(rel);
  while (true) {
    dirs.push(dir === "." ? "" : dir);
    if (dir === "." || dir === "") break;
    dir = path.posix.dirname(dir);
  }
  return dirs;
}

/** Resolve a Kotlin `import a.b.C` to the source files of its package. Kotlin file
 *  naming is free-form (a file holds any number of declarations and need not be named
 *  after a class), so — like Go's "package = directory" — a `import` links to every
 *  `.kt` file in the package's directory rather than to one file. The package is the
 *  dotted name with its trailing symbol dropped: segments before the first PascalCase
 *  one (Java's class-boundary heuristic), or all-but-last for an all-lowercase member
 *  import; a `*` wildcard imports the package itself, so nothing is dropped. The
 *  directory lives under a source root (e.g. `src/main/kotlin`), found by ancestor-scan;
 *  a framework/stdlib package matches nothing on disk. (ama-e23) */
function kotlinImports(
  node: Parser.SyntaxNode,
  importerRel: string,
  root: string,
): string[][] | undefined {
  if (node.type !== "import_header") return undefined;
  const id = node.namedChildren.find((c) => c.type === "identifier");
  if (!id) return [];
  const segments = id.text.split(".");
  const wildcard = node.namedChildren.some((c) => c.type === "wildcard_import");
  const pascal = segments.findIndex((s) => /^[A-Z]/.test(s));
  const pkg = wildcard
    ? segments // `import a.b.*` → the package is a.b
    : pascal >= 0
      ? segments.slice(0, pascal) // `import a.b.C` → package a.b (C is the type)
      : segments.slice(0, -1); // `import a.b.foo` → package a.b (foo is a member)
  if (pkg.length === 0) return [];
  const pkgPath = pkg.join("/");
  for (const ancestor of ancestorDirs(importerRel)) {
    const rel = ancestor ? `${ancestor}/${pkgPath}` : pkgPath;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue; // not a directory under this ancestor
    }
    const files = entries
      .filter((e) => e.isFile() && (e.name.endsWith(".kt") || e.name.endsWith(".kts")))
      .map((e) => `${rel}/${e.name}`)
      .filter((f) => f !== importerRel);
    if (files.length > 0) return files.map((f) => [f]); // one File→File edge per .kt file
  }
  return []; // a stdlib/framework package, or none on disk
}

/**
 * Baseline (syntactic) spec for Kotlin. tree-sitter-kotlin uses one
 * `class_declaration` for class / interface / enum class (refined to Enum by its
 * `enum_class_body`; interfaces stay Class at this tier), `object_declaration`
 * for singletons, and `function_declaration` for functions — methods nest under
 * their class (e.g. `Sample.square`). None carry a `name` field, so the analyzer
 * reads the name from the first identifier child. (ama-0ze)
 */
export const kotlinSpec: LanguageSpec = {
  language: "kotlin",
  extensions: [".kt", ".kts"],
  grammar: "kotlin",
  symbols: {
    class_declaration: { kind: "Class", kindByChild: { enum_class_body: "Enum" } },
    object_declaration: { kind: "Class" },
    function_declaration: { kind: "Function" },
  },
  resolveImports: kotlinImports,
};
