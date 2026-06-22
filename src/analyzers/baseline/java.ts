import type Parser from "web-tree-sitter";
import { type GraphEdge, type GraphNode, symbolId } from "../../graph/index.js";
import type { LanguageSpec } from "./analyzer.js";
import { ancestorDirs } from "./paths.js";

/** Try a repo-relative file under every ancestor directory of the importer. A
 *  package import gives a *source-root-relative* path (`com/example/Foo.java`)
 *  but not the source root itself (`src/main/java`), which varies by build tool —
 *  so the correct root is simply whichever ancestor makes the file exist. Disk-
 *  based (via the analyzer's existsSync), so it's single-file-reindex-safe. */
function ancestorCandidates(importerRel: string, file: string): string[] {
  return ancestorDirs(importerRel).map((d) => (d ? `${d}/${file}` : file));
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

/** Spring method-mapping annotations → HTTP verb. `@RequestMapping` is the class-level prefix. */
const JAVA_MAPPING_VERBS = new Map([
  ["GetMapping", "GET"],
  ["PostMapping", "POST"],
  ["PutMapping", "PUT"],
  ["DeleteMapping", "DELETE"],
  ["PatchMapping", "PATCH"],
]);

function firstOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
  if (node.type === type) return node;
  for (const c of node.namedChildren) {
    const found = firstOfType(c, type);
    if (found) return found;
  }
  return undefined;
}

function* eachClass(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  if (node.type === "class_declaration") yield node;
  for (const c of node.namedChildren) yield* eachClass(c);
}

/** The string argument of an `@Annotation("x")`, or undefined for a marker annotation. */
function annotationArg(ann: Parser.SyntaxNode): string | undefined {
  return firstOfType(ann, "string_fragment")?.text;
}

/** Combine a Spring class prefix and a method sub-path into a normalized `:param` route. */
function joinJavaRoutePath(prefix: string, sub: string): string {
  const norm = (s: string) => s.replace(/\{([^}]+)\}/g, ":$1");
  const segs = [norm(prefix), norm(sub)].flatMap((s) => s.split("/")).filter(Boolean);
  return `/${segs.join("/")}`;
}

/** Detect Spring MVC routes: a class `@RequestMapping("/prefix")` prefixes each method's
 *  `@GetMapping`/`@PostMapping`/… (path or marker) to form a `METHOD /prefix/path` Route that
 *  references the method (`Class.method`). (ama-a2r) */
function javaRoutes(
  root: Parser.SyntaxNode,
  rel: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const annotationsOf = (node: Parser.SyntaxNode) =>
    (node.namedChildren.find((c) => c.type === "modifiers")?.namedChildren ?? []).filter(
      (a) => a.type === "annotation" || a.type === "marker_annotation",
    );
  for (const cls of eachClass(root)) {
    const className = cls.childForFieldName("name")?.text;
    const prefix =
      annotationsOf(cls).find((a) => a.childForFieldName("name")?.text === "RequestMapping") ??
      null;
    const classPrefix = prefix ? (annotationArg(prefix) ?? "") : "";
    const body = cls.childForFieldName("body");
    for (const member of body?.namedChildren ?? []) {
      if (member.type !== "method_declaration") continue;
      const mapping = annotationsOf(member)
        .map((a) => ({
          verb: JAVA_MAPPING_VERBS.get(a.childForFieldName("name")?.text ?? ""),
          ann: a,
        }))
        .find((m) => m.verb);
      if (!mapping?.verb) continue;
      const methodName = member.childForFieldName("name")?.text;
      const name = `${mapping.verb} ${joinJavaRoutePath(classPrefix, annotationArg(mapping.ann) ?? "")}`;
      const routeId = symbolId({ file: rel, qualifiedName: name });
      nodes.push({
        id: routeId,
        kind: "Route",
        name,
        file: rel,
        qualifiedName: name,
        tier: "baseline",
        range: { startLine: member.startPosition.row + 1, endLine: member.endPosition.row + 1 },
      });
      if (className && methodName) {
        edges.push({
          from: routeId,
          to: symbolId({ file: rel, qualifiedName: `${className}.${methodName}` }),
          kind: "References",
          provenance: "heuristic",
        });
      }
    }
  }
  return { nodes, edges };
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
  collectRoutes: javaRoutes,
};
