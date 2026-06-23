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

/** JAX-RS verb marker annotations (`@GET`/`@POST`/…) → HTTP verb. The path comes from a separate
 *  `@Path` on the class (prefix) and method (sub-path), so these mark the verb only. */
const JAVA_JAXRS_VERBS = new Map([
  ["GET", "GET"],
  ["POST", "POST"],
  ["PUT", "PUT"],
  ["DELETE", "DELETE"],
  ["PATCH", "PATCH"],
  ["HEAD", "HEAD"],
  ["OPTIONS", "OPTIONS"],
]);

/** Javalin route-registration methods (`app.get("/x", handler)`) → HTTP verb. */
const JAVA_JAVALIN_VERBS = new Map([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["delete", "DELETE"],
  ["patch", "PATCH"],
  ["head", "HEAD"],
  ["options", "OPTIONS"],
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

/** The last dotted segment of an annotation name — so fully-qualified annotations like
 *  `@org.springframework.web.bind.annotation.GetMapping` resolve to `GetMapping` and match
 *  the simple-name entries in `JAVA_MAPPING_VERBS` / `JAVA_JAXRS_VERBS`. A plain identifier
 *  name (e.g. `GetMapping`) is returned as-is. */
function annotationSimpleName(ann: Parser.SyntaxNode): string | undefined {
  const nameNode = ann.childForFieldName("name");
  if (!nameNode) return undefined;
  if (nameNode.type === "identifier") return nameNode.text;
  // scoped_identifier: walk to the outermost named child that is an `identifier` (the right-most
  // segment). The tree-sitter-java CST nests left-associatively, so the rightmost identifier is
  // the last namedChild of the outermost scoped_identifier.
  if (nameNode.type === "scoped_identifier") {
    const ids = nameNode.namedChildren.filter((c) => c.type === "identifier");
    return ids[ids.length - 1]?.text;
  }
  return nameNode.text;
}

/** The route-path string argument of an annotation, honouring named-arg order:
 *  - If there are ANY `element_value_pair` children in the argument list, look for one named
 *    `value` or `path` (in that precedence order) and return its string value.
 *  - If there are NO named pairs (i.e. a single positional arg `@GetMapping("/x")`), fall back
 *    to the first `string_fragment` inside the argument list.
 *  Returns `undefined` for a marker annotation (no argument list / no string). */
function annotationArg(ann: Parser.SyntaxNode): string | undefined {
  const argList = ann.namedChildren.find((c) => c.type === "annotation_argument_list");
  if (!argList) return undefined;
  const pairs = argList.namedChildren.filter((c) => c.type === "element_value_pair");
  if (pairs.length > 0) {
    // Named-arg form: prefer `value=` then `path=`; ignore other pairs (e.g. `produces=`).
    for (const key of ["value", "path"]) {
      const pair = pairs.find((p) => p.namedChildren[0]?.text === key);
      if (pair) {
        const strLit = pair.namedChildren.find((c) => c.type === "string_literal");
        return firstOfType(strLit ?? pair, "string_fragment")?.text;
      }
    }
    return undefined; // named pairs present but none are `value`/`path` → no path arg
  }
  // Positional single-arg form — take the first string_fragment anywhere in the list.
  return firstOfType(argList, "string_fragment")?.text;
}

/** Combine a Spring class prefix and a method sub-path into a normalized `:param` route. */
function joinJavaRoutePath(prefix: string, sub: string): string {
  const norm = (s: string) => s.replace(/\{([^}]+)\}/g, ":$1");
  const segs = [norm(prefix), norm(sub)].flatMap((s) => s.split("/")).filter(Boolean);
  return `/${segs.join("/")}`;
}

/** The annotation/marker_annotation nodes on a declaration (under its `modifiers` child). */
function annotationsOf(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return (node.namedChildren.find((c) => c.type === "modifiers")?.namedChildren ?? []).filter(
    (a) => a.type === "annotation" || a.type === "marker_annotation",
  );
}

/** Emit a `VERB /path` Route node referencing its handler (`Class.method`), shared by every framework
 *  detector. Framework dispatch is modeled as a Route + `References` → handler — NEVER a Calls edge, so
 *  find_callers stays honestly empty while find_handlers/find_routes/impact_analysis surface it. */
function emitRoute(
  rel: string,
  verb: string,
  routePath: string,
  handlerQn: string | undefined,
  range: { startLine: number; endLine: number },
  out: { nodes: GraphNode[]; edges: GraphEdge[] },
): void {
  const name = `${verb} ${routePath}`;
  const routeId = symbolId({ file: rel, qualifiedName: name });
  out.nodes.push({
    id: routeId,
    kind: "Route",
    name,
    file: rel,
    qualifiedName: name,
    tier: "baseline",
    range,
  });
  if (handlerQn) {
    out.edges.push({
      from: routeId,
      to: symbolId({ file: rel, qualifiedName: handlerQn }),
      kind: "References",
      provenance: "heuristic",
    });
  }
}

/** Detect Spring MVC + JAX-RS routes: a class prefix (`@RequestMapping`/`@Path`) composes with each
 *  method's verb mapping (`@GetMapping`/… for Spring, the `@GET`/… marker + optional `@Path` for
 *  JAX-RS) into a `METHOD /prefix/path` Route referencing the method (`Class.method`). Plus Javalin
 *  call sites (`app.get("/x", handler)`). All baseline-tier, dispatch via References (never Calls).
 *  (ama-a2r, ama 0.4.0 S4) */
function javaRoutes(
  root: Parser.SyntaxNode,
  rel: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const out = { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
  for (const cls of eachClass(root)) {
    const classAnns = annotationsOf(cls);
    // Spring class prefix (`@RequestMapping("/x")`) and JAX-RS class prefix (`@Path("/x")`).
    const springPrefix = classAnns.find((a) => annotationSimpleName(a) === "RequestMapping");
    const springClassPath = springPrefix ? (annotationArg(springPrefix) ?? "") : "";
    const jaxrsPrefix = classAnns.find((a) => annotationSimpleName(a) === "Path");
    const jaxrsClassPath = jaxrsPrefix ? (annotationArg(jaxrsPrefix) ?? "") : "";
    const body = cls.childForFieldName("body");
    for (const member of body?.namedChildren ?? []) {
      if (member.type !== "method_declaration") continue;
      const methodAnns = annotationsOf(member);
      // Derive the handler qn from the method CST node via javaQualifiedName — the SAME helper
      // walkSymbols' dotted chain uses — so the References endpoint matches the Method node id even
      // for a nested/inner controller (`Outer.Inner.list`, not the simple-class `Inner.list`). A bare
      // `${className}.${methodName}` would dangle the edge for nested classes (the #34 class of bug).
      const handlerQn = javaQualifiedName(member);
      const range = {
        startLine: member.startPosition.row + 1,
        endLine: member.endPosition.row + 1,
      };

      // Spring: a single `@GetMapping`/… carries both verb and (optional) sub-path.
      // `annotationSimpleName` strips FQN prefixes so `@org.springframework…GetMapping` resolves.
      const spring = methodAnns
        .map((a) => ({
          verb: JAVA_MAPPING_VERBS.get(annotationSimpleName(a) ?? ""),
          ann: a,
        }))
        .find((m) => m.verb);
      if (spring?.verb) {
        emitRoute(
          rel,
          spring.verb,
          joinJavaRoutePath(springClassPath, annotationArg(spring.ann) ?? ""),
          handlerQn,
          range,
          out,
        );
        continue;
      }

      // JAX-RS: the verb is a `@GET`/… marker; the sub-path is a separate method `@Path` (or none).
      const jaxrsVerb = methodAnns
        .map((a) => JAVA_JAXRS_VERBS.get(annotationSimpleName(a) ?? ""))
        .find(Boolean);
      if (jaxrsVerb) {
        const methodPathAnn = methodAnns.find((a) => annotationSimpleName(a) === "Path");
        const sub = methodPathAnn ? (annotationArg(methodPathAnn) ?? "") : "";
        emitRoute(rel, jaxrsVerb, joinJavaRoutePath(jaxrsClassPath, sub), handlerQn, range, out);
      }
    }
  }
  collectJavalinRoutes(root, rel, out);
  return out;
}

/** The handler symbol a Javalin route argument names: a method reference (`App::health` → `App.health`)
 *  resolves to a `Class.method` qualified name. A lambda/identifier handler has no resolvable symbol
 *  node at baseline, so it's left handler-less (Route still emitted) rather than dangling an edge. */
function javalinHandlerQn(arg: Parser.SyntaxNode | undefined): string | undefined {
  if (arg?.type !== "method_reference") return undefined;
  const ids = arg.namedChildren.filter((c) => c.type === "identifier");
  const owner = ids[0]?.text;
  const method = ids[1]?.text;
  return owner && method ? `${owner}.${method}` : undefined;
}

/** Names of local/field handles assigned from `Javalin.create(...)` in this file — the receivers a
 *  genuine Javalin route registers on (`app.get(...)`). Used to tell a real route apart from an
 *  ordinary `map.get("k")` / `cache.put("k", v)` stdlib call that shares the verb method name. */
function javalinAppHandles(root: Parser.SyntaxNode): Set<string> {
  const handles = new Set<string>();
  // `Javalin.create()` / `Javalin.create(cfg)` is a method_invocation with object `Javalin`, name `create`.
  const isJavalinCreate = (node: Parser.SyntaxNode | null | undefined): boolean =>
    !!node &&
    node.type === "method_invocation" &&
    node.childForFieldName("object")?.text === "Javalin" &&
    node.childForFieldName("name")?.text === "create";
  // `Javalin app = Javalin.create();` — a local_variable_declaration with a Javalin.create() initializer.
  for (const decl of eachOfType(root, "variable_declarator")) {
    const name = decl.childForFieldName("name")?.text;
    if (name && isJavalinCreate(decl.childForFieldName("value"))) handles.add(name);
  }
  // `app = Javalin.create();` — a plain (re)assignment to an existing local/field.
  for (const assign of eachOfType(root, "assignment_expression")) {
    const left = assign.childForFieldName("left");
    if (left?.type === "identifier" && isJavalinCreate(assign.childForFieldName("right"))) {
      handles.add(left.text);
    }
  }
  return handles;
}

/** Is `arg` a Javalin handler argument shape — a method reference (`App::health`), a lambda
 *  (`ctx -> {...}`), or a bare handler identifier — as opposed to a value/key argument? Used as the
 *  fallback signal that an unknown-receiver `x.get("/p", h)` is a real route, not a `map.get("k")`. */
function isHandlerArg(arg: Parser.SyntaxNode | undefined): boolean {
  return (
    arg?.type === "method_reference" ||
    arg?.type === "lambda_expression" ||
    arg?.type === "identifier"
  );
}

/** Detect Javalin call-site routes: `app.get("/path", handler)` → a `GET /path` Route referencing the
 *  handler (when it's a `Class::method` reference). Call-site, not annotation-driven.
 *
 *  Honesty gate (0.4.0 review): the verb method names (`get`/`put`/`post`/…) collide with ubiquitous
 *  stdlib calls (`map.get("k")`, `cache.put("k", v)`, `Optional.get()`), so matching name + a string
 *  first arg alone fabricates phantom routes. Emit ONLY when the receiver is a tracked Javalin app
 *  handle (assigned from `Javalin.create()`), OR — when the receiver can't be resolved — the second
 *  argument is a handler (method reference / lambda / identifier). A single-arg `map.get("k")` then
 *  never matches. (ama 0.4.0 S4) */
function collectJavalinRoutes(
  root: Parser.SyntaxNode,
  rel: string,
  out: { nodes: GraphNode[]; edges: GraphEdge[] },
): void {
  const appHandles = javalinAppHandles(root);
  for (const call of eachOfType(root, "method_invocation")) {
    const verb = JAVA_JAVALIN_VERBS.get(call.childForFieldName("name")?.text ?? "");
    if (!verb) continue;
    const args = call.childForFieldName("arguments");
    const named = args?.namedChildren ?? [];
    const pathArg = named[0];
    if (pathArg?.type !== "string_literal") continue; // first arg must be a literal route path
    const routePath = firstOfType(pathArg, "string_fragment")?.text;
    if (routePath === undefined) continue;
    // Gate on Javalin shape: a tracked app receiver, or (receiver unknown) a handler 2nd argument.
    const receiver = call.childForFieldName("object");
    const onAppHandle = receiver?.type === "identifier" && appHandles.has(receiver.text);
    if (!onAppHandle && !isHandlerArg(named[1])) continue;
    emitRoute(
      rel,
      verb,
      joinJavaRoutePath("", routePath),
      javalinHandlerQn(named[1]),
      {
        startLine: call.startPosition.row + 1,
        endLine: call.endPosition.row + 1,
      },
      out,
    );
  }
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
 *  id of the Method node walkSymbols already emitted, so call edges resolve to it.
 *
 *  Anonymous-class methods fold into the enclosing method's namespace: `new Foo(){void run(){}}` inside
 *  `Outer.method()` yields `Outer.method.run`. This is intentional — `object_creation_expression`
 *  (the anonymous-class wrapper) is not in `JAVA_SYMBOL_TYPES`, so the traversal skips it and lands
 *  on `method_declaration` (the enclosing named method) as the next qualifying ancestor, giving the
 *  same dotted chain that walkSymbols' recursion through non-symbol nodes produces. (S2, #34) */
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
  // Within-file: overloaded constructors/methods collide by simple name → null (ambiguous → skipped).
  // Cross-file: only one definition per simple name exists per file in `funcsByFile` (deriveCallEdges
  // first-wins), so an overloaded target resolves to the FIRST matching definition in the imported file —
  // an arbitrary overload, not skipped. This is a known baseline limitation (deep-tier #15). (S2)
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
    case "array_type":
      // `Foo[]` → strip the array to its element type (first child); the `dimensions` child is skipped.
      return node.namedChildren[0] ? baseTypeName(node.namedChildren[0]) : undefined;
    default:
      // Primitive (integral_type/floating_point_type/boolean_type), void_type, wildcards, etc. name
      // no on-disk type — no UsesType candidate. (S3 honesty: only real type references get an edge.)
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

/** The `field_declaration`s lexically inside a class/interface/enum body — direct body members only,
 *  so a field of a nested type isn't double-counted under its enclosing type. */
function* eachField(
  node: Parser.SyntaxNode,
): Generator<{ field: Parser.SyntaxNode; ownerQn: string }> {
  for (const { node: decl, qn } of eachTypeDecl(node)) {
    const body = decl.childForFieldName("body");
    for (const member of body?.namedChildren ?? []) {
      if (member.type === "field_declaration") yield { field: member, ownerQn: qn };
    }
  }
}

/** Baseline field + type-use edges for Java. Each `field_declaration` declarator becomes a `Property`
 *  node (`Class.field`, multi-declarator aware: `int a, b;` → two), with a `Defines` edge from its
 *  declaring type and a `UsesType` `type:<SimpleName>` candidate to the field's declared type (generics
 *  stripped to the base, arrays to the element type; primitives/voids name no type and are skipped).
 *  Method parameter and return types add `UsesType` candidates from the method too. {@link deriveTypeEdges}
 *  relinks the candidates whole-graph, powering find_type_users / find_types_used. (ama 0.4.0 S3) */
function javaFields(
  root: Parser.SyntaxNode,
  rel: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  // A `UsesType` candidate from `fromId` to the base type of `typeNode`, deduped. Primitives/voids
  // (baseTypeName → undefined) name no on-disk type, so no edge — keeping baseline honest.
  const usesType = (fromId: string, typeNode: Parser.SyntaxNode | null | undefined) => {
    const name = typeNode ? baseTypeName(typeNode) : undefined;
    if (!name) return;
    const to = `${TYPE_REF_PREFIX}${name}`;
    const key = `${fromId} ${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: fromId, to, kind: "UsesType", provenance: "heuristic" });
  };

  for (const { field, ownerQn } of eachField(root)) {
    const typeNode = field.childForFieldName("type");
    const ownerId = symbolId({ file: rel, qualifiedName: ownerQn });
    // Multi-declarator: `int a, b;` exposes only the first via the `declarator` field, so iterate all
    // `variable_declarator` named children to emit a Property per declared name.
    for (const decl of field.namedChildren) {
      if (decl.type !== "variable_declarator") continue;
      const name = decl.childForFieldName("name")?.text;
      if (!name) continue;
      const qualifiedName = `${ownerQn}.${name}`;
      const id = symbolId({ file: rel, qualifiedName });
      nodes.push({
        id,
        kind: "Property",
        name,
        file: rel,
        qualifiedName,
        tier: "baseline",
        range: { startLine: decl.startPosition.row + 1, endLine: decl.endPosition.row + 1 },
      });
      edges.push({ from: ownerId, to: id, kind: "Defines" });
      usesType(id, typeNode);
    }
  }

  // Method param + return types: a `UsesType` from the method to each named (non-primitive) type.
  for (const method of eachOfType(root, "method_declaration")) {
    const qn = javaQualifiedName(method);
    if (!qn) continue;
    const methodId = symbolId({ file: rel, qualifiedName: qn });
    usesType(methodId, method.childForFieldName("type")); // return type (void_type → skipped)
    const params = method.childForFieldName("parameters");
    for (const param of params?.namedChildren ?? []) {
      if (param.type === "formal_parameter") usesType(methodId, param.childForFieldName("type"));
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
    constructor_declaration: { kind: "Method" },
  },
  resolveImports: javaImports,
  collectRoutes: javaRoutes,
  collectCalls: javaCalls,
  collectHierarchy: javaHierarchy,
  collectFields: javaFields,
};
