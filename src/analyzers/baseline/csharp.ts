import * as fs from "node:fs";
import * as path from "node:path";
import type Parser from "web-tree-sitter";
import type { LanguageSpec } from "./analyzer.js";
import { nearestConfig, parentDir } from "./config.js";
import { ancestorDirs } from "./paths.js";

/** Cache for the nearest `.csproj`'s root namespace, by importer directory. */
const csprojCache = new Map<string, { dir: string; value: string } | null>();

/** The C# root namespace declared by a `.csproj` in `absDir` — its `<RootNamespace>`, or
 *  (the C# default) the project file's base name. Undefined when `absDir` holds no
 *  `.csproj`, so the walk-up continues. (ama-66z) */
function readCsprojRootNamespace(absDir: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const proj = entries.find((e) => e.isFile() && e.name.endsWith(".csproj"));
  if (!proj) return undefined;
  try {
    const content = fs.readFileSync(path.join(absDir, proj.name), "utf8");
    return (
      content.match(/<RootNamespace>\s*([^<\s]+)\s*<\/RootNamespace>/)?.[1] ??
      proj.name.replace(/\.csproj$/i, "")
    );
  } catch {
    return proj.name.replace(/\.csproj$/i, ""); // unreadable body — default to the file name
  }
}

/** The `.cs` files directly in repo-relative `rel` (excluding the importer), one
 *  File→File candidate group each — or undefined if `rel` isn't a directory or holds no
 *  `.cs` files. */
function csFilesIn(root: string, rel: string, importerRel: string): string[][] | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return undefined; // not a directory on disk
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".cs"))
    .map((e) => (rel ? `${rel}/${e.name}` : e.name))
    .filter((f) => f !== importerRel);
  return files.length > 0 ? files.map((f) => [f]) : undefined;
}

/** Resolve a C# `using A.B.C;` to the source files of that namespace. C# has no 1:1
 *  namespace→file mapping: a namespace is a *set* of files, conventionally a directory,
 *  so a `using` links to every `.cs` file in the matching directory — the "package =
 *  directory" shape Go has. Two strategies, precise first: (1) if the namespace is under
 *  the nearest `.csproj`'s root namespace (`<RootNamespace>`, else the project file
 *  name), map it *exactly* to that project's directory tree — avoiding a coincidental
 *  match at a closer ancestor. (2) Otherwise (a namespace from another project, or no
 *  `.csproj`), ancestor-scan from the importer's own directory upward, trying
 *  progressively shorter suffixes of the dotted name — longest (most specific) first —
 *  and take the first directory holding `.cs` files; this favors recall. `using Alias =
 *  …` and framework namespaces resolve to nothing. (ama-7e3, ama-66z) */
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

  // (1) Precise: a namespace under this project's root namespace maps to an exact dir.
  const proj = nearestConfig(root, parentDir(importerRel), readCsprojRootNamespace, csprojCache);
  if (proj && (name.text === proj.value || name.text.startsWith(`${proj.value}.`))) {
    const sub = name.text === proj.value ? "" : name.text.slice(proj.value.length + 1);
    const exact = [proj.dir, sub.replace(/\./g, "/")].filter(Boolean).join("/");
    const files = csFilesIn(root, exact, importerRel);
    if (files) return files;
  }

  // (2) Heuristic fallback: ancestor-scan + progressively shorter suffixes (recall).
  const segments = name.text.split(".");
  for (const ancestor of ancestorDirs(importerRel)) {
    for (let len = segments.length; len >= 1; len--) {
      const rel = [ancestor, ...segments.slice(segments.length - len)].filter(Boolean).join("/");
      const files = csFilesIn(root, rel, importerRel);
      if (files) return files;
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
