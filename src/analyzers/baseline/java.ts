import type Parser from "web-tree-sitter";
import {
  CALL_REF_PREFIX,
  type GraphEdge,
  type GraphNode,
  TYPE_REF_PREFIX,
  symbolId,
} from "../../graph/index.js";
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

/** Symbol-typed Java CST nodes — the ones walkSymbols turns into graph nodes — so a method's
 *  qualified name is the dotted chain of these ancestors' names (e.g. `Sample.square`). */
const JAVA_SYMBOL_TYPES = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "method_declaration",
  // A constructor's `name` field is the class identifier, so it qualifies as `Class.Class` — keeping
  // its dotted chain consistent with walkSymbols so a `new Foo(...)` call edge resolves to it. (S2)
  "constructor_declaration",
]);

/** Reproduce walkSymbols' dotted qualified name for `node`: the `name` of each symbol-typed
 *  ancestor, outermost first. Undefined if a link is anonymous (can't qualify) — it must match the
 *  id of the Method node walkSymbols already emitted, so call edges resolve to it. */
function javaQualifiedName(node: Parser.SyntaxNode): string | undefined {
  const parts: string[] = [];
  for (let n: Parser.SyntaxNode | null = node; n; n = n.parent) {
    if (!JAVA_SYMBOL_TYPES.has(n.type)) continue;
    const name = n.childForFieldName("name")?.text;
    if (!name) return undefined;
    parts.unshift(name);
  }
  return parts.length ? parts.join(".") : undefined;
}

/** Every descendant (and self) of a given CST type. */
function* eachOfType(node: Parser.SyntaxNode, type: string): Generator<Parser.SyntaxNode> {
  if (node.type === type) yield node;
  for (const c of node.namedChildren) yield* eachOfType(c, type);
}

/** The nearest enclosing method or constructor — the symbol a call site (call or `new`) belongs to. */
function enclosingMethod(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === "method_declaration" || n.type === "constructor_declaration") return n;
  }
  return undefined;
}

/** Method names ubiquitous on java.lang.Object / common stdlib types — a baseline call to one of
 *  these (`obj.toString()`, `System.out.println(...)`) almost never targets a user method in an
 *  imported file, so a `call:` candidate for it is pure noise (it cannot resolve, or resolves wrong
 *  by name). Conservative on purpose — only names you would never define-and-call cross-file. (#38) */
const JAVA_BUILTINS = new Set([
  "toString",
  "equals",
  "hashCode",
  "getClass",
  "clone",
  "finalize",
  "notify",
  "notifyAll",
  "wait",
  "println",
  "print",
]);

/** Heuristic baseline call edges for Java. A `method_invocation` whose name matches a method defined
 *  in the SAME file resolves by name to a `Calls` edge from the enclosing method (within-file); a
 *  non-local name becomes a `call:<name>` candidate that {@link deriveCallEdges} resolves cross-file
 *  via the import graph — so find_callers/find_callees span Java classes and files instead of the
 *  empty `callsTotal: 0` the baseline tier used to give. A name defined more than once locally is
 *  ambiguous (skipped); a call outside any method is skipped. (#34) */
function javaCalls(
  root: Parser.SyntaxNode,
  rel: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  // Both methods and constructors register by simple name: a constructor's `name` field is the class
  // identifier, so `new Foo(...)` (callee simple name `Foo`) resolves to the `Foo.Foo` constructor.
  // Overloaded constructors/methods collide by simple name → null (ambiguous), so they stay skipped:
  // disambiguating an overload by argument shape is deep-tier, not baseline. (S2)
  const byName = new Map<string, string | null>(); // simple name → id, or null when ambiguous
  for (const m of [
    ...eachOfType(root, "method_declaration"),
    ...eachOfType(root, "constructor_declaration"),
  ]) {
    const qn = javaQualifiedName(m);
    const simple = m.childForFieldName("name")?.text;
    if (!qn || !simple) continue;
    byName.set(simple, byName.has(simple) ? null : symbolId({ file: rel, qualifiedName: qn }));
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  // Emit a call edge for a call site in `enc` whose callee simple name is `name`: a within-file
  // `Calls` edge if the name is defined here unambiguously, else a cross-file `call:` candidate.
  const callSite = (enc: Parser.SyntaxNode, name: string) => {
    const local = byName.get(name);
    if (local === null) return; // a name defined more than once locally — don't guess
    const callerQn = javaQualifiedName(enc);
    if (!callerQn) return;
    const from = symbolId({ file: rel, qualifiedName: callerQn });
    if (local) {
      // resolved within this file (slice 1)
      const key = `c ${from} ${local}`;
      if (from === local || seen.has(key)) return; // skip self-recursion + duplicate sites
      seen.add(key);
      edges.push({ from, to: local, kind: "Calls", provenance: "heuristic" });
    } else if (!JAVA_BUILTINS.has(name)) {
      // not local — a cross-file candidate deriveCallEdges resolves via the import graph (slice 2)
      const key = `r ${from} ${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({
        from,
        to: `${CALL_REF_PREFIX}${name}`,
        kind: "References",
        provenance: "call-ref",
      });
    }
  };
  for (const call of eachOfType(root, "method_invocation")) {
    const enc = enclosingMethod(call);
    const name = call.childForFieldName("name")?.text;
    if (enc && name) callSite(enc, name);
  }
  for (const create of eachOfType(root, "object_creation_expression")) {
    // `new Foo(...)` is a call to Foo's constructor (callee simple name = constructed type). Skip an
    // anonymous class (`new Foo(){...}` carries a class_body) — it defines no resolvable ctor. (S2)
    if (create.namedChildren.some((c) => c.type === "class_body")) continue;
    const typeNode = create.childForFieldName("type");
    const name = typeNode ? baseTypeName(typeNode) : undefined;
    const enc = enclosingMethod(create);
    if (enc && name) callSite(enc, name);
  }
  return { nodes: [], edges };
}

/** The base type's *simple* name for a supertype CST node, stripping generics to the parameterized
 *  type (`List<String>` → `List`) and a scoped name to its last segment (`a.b.Foo` → `Foo`). Returns
 *  undefined for shapes that name no type (wildcards etc.). (ama 0.4.0 S1) */
function baseTypeName(node: Parser.SyntaxNode): string | undefined {
  switch (node.type) {
    case "type_identifier":
      return node.text;
    case "generic_type":
      // first namedChild is the base type (`List` of `List<String>`); recurse to strip a scoped base.
      return node.namedChildren[0] ? baseTypeName(node.namedChildren[0]) : undefined;
    case "scoped_type_identifier": {
      // base/simple type is the LAST type_identifier (`Bar` of `Foo.Bar`).
      const ids = node.namedChildren.filter((c) => c.type === "type_identifier");
      return ids[ids.length - 1]?.text;
    }
    default:
      return undefined;
  }
}

/** Class/interface/enum declarations anywhere in the tree (incl. nested/local), each with its
 *  walkSymbols-consistent dotted qualified name so a hierarchy edge's `from` matches the type's
 *  graph-node id. Anonymous links yield undefined and are skipped. */
function* eachTypeDecl(
  node: Parser.SyntaxNode,
): Generator<{ node: Parser.SyntaxNode; qn: string }> {
  if (
    node.type === "class_declaration" ||
    node.type === "interface_declaration" ||
    node.type === "enum_declaration"
  ) {
    const qn = javaQualifiedName(node);
    if (qn) yield { node, qn };
  }
  for (const c of node.namedChildren) yield* eachTypeDecl(c);
}

/** The CST nodes naming each supertype in a `type_list` (class `implements`, interface `extends`). */
function typeListMembers(list: Parser.SyntaxNode | undefined): Parser.SyntaxNode[] {
  const tl = list?.namedChildren.find((c) => c.type === "type_list");
  return tl ? [...tl.namedChildren] : [];
}

/** Baseline type-hierarchy edges for Java: `class extends` / `interface extends` → `Inherits`,
 *  `class`/`enum` `implements` (and interface-extends-list) → the matching kind, with each supertype
 *  resolved to a within-file type id or, failing that, a `type:<SimpleName>` candidate
 *  {@link deriveTypeEdges} relinks whole-graph. No `@Override`/signature work — {@link deriveDispatchEdges}
 *  derives `Overrides` and virtual dispatch from these resolved edges. (ama 0.4.0 S1) */
function javaHierarchy(
  root: Parser.SyntaxNode,
  rel: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  // Within-file type ids by simple name; first definition wins, and ambiguous (collision) → null so
  // a same-named local type can't mis-resolve (the candidate falls through to type: instead).
  const byName = new Map<string, string | null>();
  for (const { node, qn } of eachTypeDecl(root)) {
    const simple = node.childForFieldName("name")?.text;
    if (!simple) continue;
    byName.set(simple, byName.has(simple) ? null : symbolId({ file: rel, qualifiedName: qn }));
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const link = (fromId: string, supertype: Parser.SyntaxNode, kind: "Inherits" | "Implements") => {
    const name = baseTypeName(supertype);
    if (!name) return;
    const local = byName.get(name);
    if (local === null) return; // ambiguous local type — don't guess; drop rather than mis-link
    const to = local ?? `${TYPE_REF_PREFIX}${name}`;
    if (to === fromId) return; // a type can't extend itself
    const key = `${fromId} ${kind} ${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: fromId, to, kind, provenance: "heuristic" });
  };

  for (const { node, qn } of eachTypeDecl(root)) {
    const fromId = symbolId({ file: rel, qualifiedName: qn });
    if (node.type === "class_declaration") {
      const sup = node.childForFieldName("superclass");
      // `superclass` wraps a single positional type child (no named field).
      const supType = sup?.namedChildren[0];
      if (supType) link(fromId, supType, "Inherits");
      for (const m of typeListMembers(node.childForFieldName("interfaces") ?? undefined)) {
        link(fromId, m, "Implements");
      }
    } else if (node.type === "enum_declaration") {
      for (const m of typeListMembers(node.childForFieldName("interfaces") ?? undefined)) {
        link(fromId, m, "Implements");
      }
    } else if (node.type === "interface_declaration") {
      // interface-extends has no field — `extends_interfaces` is a positional child wrapping a type_list.
      const ext = node.namedChildren.find((c) => c.type === "extends_interfaces");
      for (const m of typeListMembers(ext)) link(fromId, m, "Inherits");
    }
  }
  return { nodes: [], edges };
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
    constructor_declaration: { kind: "Method" },
  },
  resolveImports: javaImports,
  collectRoutes: javaRoutes,
  collectCalls: javaCalls,
  collectHierarchy: javaHierarchy,
};
