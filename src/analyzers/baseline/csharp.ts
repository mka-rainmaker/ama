import * as fs from "node:fs";
import * as path from "node:path";
import type Parser from "web-tree-sitter";
import type { LanguageSpec } from "./analyzer.js";
import { ancestorDirs } from "./paths.js";

/** Resolve a C# `using A.B.C;` to the source files of that namespace. C# has no
 *  1:1 namespace→file mapping: a namespace is a *set* of files, conventionally a
 *  directory, so a `using` links to every `.cs` file in the matching directory — the
 *  same "package = directory" shape as Go. The namespace→directory mapping is by
 *  convention, and a .csproj RootNamespace can rebase it (namespace `App.Models` may
 *  live in `Models/`), so we ancestor-scan from the importer's own directory upward and
 *  try progressively shorter suffixes of the dotted name — longest (most specific)
 *  first — taking the first directory that actually holds `.cs` files. `using Alias = …`
 *  and framework namespaces (no matching directory on disk) resolve to nothing; this is
 *  a heuristic baseline (no .csproj parsing), so it favors recall. (ama-7e3) */
function csharpImports(
  node: Parser.SyntaxNode,
  importerRel: string,
  root: string,
): string[][] | undefined {
  if (node.type !== "using_directive") return undefined;
  if (node.namedChildren.some((c) => c.type === "name_equals")) return []; // `using Alias = …;`
  const name = node.namedChildren.find(
    (c) => c.type === "qualified_name" || c.type === "identifier",
  );
  if (!name) return [];
  const segments = name.text.split(".");
  for (const ancestor of ancestorDirs(importerRel)) {
    // Longest suffix first so the full namespace path beats a rebased shorter one.
    for (let len = segments.length; len >= 1; len--) {
      const rel = [ancestor, ...segments.slice(segments.length - len)].filter(Boolean).join("/");
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
      } catch {
        continue; // not a directory on disk
      }
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith(".cs"))
        .map((e) => (rel ? `${rel}/${e.name}` : e.name))
        .filter((f) => f !== importerRel);
      if (files.length > 0) return files.map((f) => [f]); // one File→File edge per .cs file
    }
  }
  return []; // a framework/NuGet namespace, or none on disk
}

/**
 * Baseline (syntactic) spec for C#. Like Java, every kind has its own CST node
 * type. Structs and records are value/data types with members, mapped to Class
 * (the graph has no dedicated struct/record kind); methods nest under their
 * type's body (e.g. `Sample.Square`).
 */
export const csharpSpec: LanguageSpec = {
  language: "csharp",
  extensions: [".cs"],
  grammar: "csharp",
  symbols: {
    class_declaration: { kind: "Class" },
    interface_declaration: { kind: "Interface" },
    struct_declaration: { kind: "Class" },
    record_declaration: { kind: "Class" },
    enum_declaration: { kind: "Enum" },
    method_declaration: { kind: "Method" },
  },
  resolveImports: csharpImports,
};
