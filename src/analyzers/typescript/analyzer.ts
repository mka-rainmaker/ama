import * as path from "node:path";
import ts from "typescript";
import { fileId, symbolId } from "../../graph/index.js";
import type { GraphEdge, GraphNode, NodeKind, SourceRange } from "../../graph/index.js";
import type { AnalysisResult, Analyzer, ResolutionStats } from "../types.js";

/**
 * Deep TypeScript analyzer built on the TypeScript Compiler API.
 *
 * Two passes over each source file:
 *  1. Structural — emit nodes (File, Function, Class, Interface, Enum, TypeAlias,
 *     Method, Property — see `describe` for the full set) and `Defines` edges,
 *     recording each declaration's AST node so later references link back to ids.
 *  2. Resolution — through the type checker, emit `Calls` edges (enclosing
 *     function/method → callee), `Inherits`/`Implements` edges (class → base
 *     class / interface), `UsesType` edges (enclosing symbol → each named type
 *     used in a parameter, return, or property annotation), and `Imports` edges
 *     (file → each symbol it imports or re-exports). References to symbols
 *     outside the analyzed set (library code) resolve to no node and are
 *     skipped, so the graph only asserts edges it can actually back.
 */
export class TypeScriptAnalyzer implements Analyzer {
  readonly language = "typescript";
  readonly tier = "deep" as const;
  readonly extensions = [".ts", ".tsx", ".mts", ".cts"] as const;

  analyze(root: string, files: string[]): AnalysisResult {
    const relByAbs = new Map<string, string>();
    for (const rel of files) relByAbs.set(path.resolve(root, rel), rel);

    const program = ts.createProgram([...relByAbs.keys()], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: false,
      noEmit: true,
      skipLibCheck: true,
    });

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const resolution: ResolutionStats = { callsTotal: 0, callsResolved: 0, unresolved: {} };
    /** AST declaration node -> graph node id, so resolved calls find their target. */
    const declToId = new Map<ts.Node, string>();

    for (const [abs, rel] of relByAbs) {
      const sf = program.getSourceFile(abs);
      if (sf) this.walkFile(sf, rel, nodes, edges, declToId);
    }

    const checker = program.getTypeChecker();

    // Mount pre-pass (all files first): map each router declaration to the path
    // prefix it's mounted at (app.use("/api", router)), so route detection can
    // prepend it. Cross-file — the checker follows imported router symbols.
    const mountPrefixes = new Map<ts.Node, string>();
    for (const abs of relByAbs.keys()) {
      const sf = program.getSourceFile(abs);
      if (sf) this.collectMounts(sf, checker, mountPrefixes);
    }

    // The Variable nodes (ama-hft.12), so collectVarReferences can emit a
    // References edge only when an identifier read resolves to one of them.
    const variableIds = new Set(nodes.filter((n) => n.kind === "Variable").map((n) => n.id));

    for (const [abs, rel] of relByAbs) {
      const sf = program.getSourceFile(abs);
      if (sf) {
        // Routes first: it registers inline-handler arrows in declToId, so the
        // following collectCalls attributes each handler's body to its node.
        this.collectRoutes(sf, rel, declToId, checker, nodes, edges, root, mountPrefixes);
        // File-based routes: the URL comes from the file path, not a call. (ama-rme.7)
        this.collectFileRoutes(sf, rel, declToId, nodes, edges);
        // Then callback-argument handlers (tap("name", () => …)) — same trick:
        // register the arrow before collectCalls so its body attributes to it.
        this.collectCallbackHandlers(sf, undefined, rel, sf, declToId, nodes, edges);
        // Events after callback-handler synthesis so inline `.on("ch", () => …)`
        // arrows are already handler nodes it can connect an emit to. (ama-hft.14)
        this.collectEvents(sf, declToId, checker, edges, root);
        this.collectCalls(sf, undefined, declToId, checker, edges, root, resolution);
        this.collectVarReferences(sf, undefined, declToId, variableIds, checker, edges, root);
        this.collectHeritage(sf, declToId, checker, edges, root);
        this.collectTypeUsages(sf, undefined, declToId, checker, edges, root);
        this.collectImports(sf, fileId(rel), declToId, checker, edges, root);
      }
    }

    this.resolveDispatch(nodes, edges);
    return { nodes, edges: accumulateCallSites(edges), resolution };
  }

  /**
   * Virtual dispatch: a call resolved to a supertype's method should also reach
   * each subtype's method of the same name — interface implementations (via
   * `Implements`) and subclass overrides (via `Inherits`). Runs after all edges
   * exist and appends extra `Calls` edges from the caller to each subtype
   * method; duplicates are collapsed by the store. One level deep (direct
   * subtypes), and only the original `Calls` edges are fanned (not the new
   * ones), so a fan-out never cascades.
   */
  private resolveDispatch(nodes: GraphNode[], edges: GraphEdge[]): void {
    const byId = new Map(nodes.map((n) => [n.id, n] as [string, GraphNode]));
    const definerOf = new Map<string, string>(); // member id -> container id
    // Subtypes of each supertype: classes that `implements` an interface and
    // subclasses that `extends` a base class — both let a call to the super's
    // method dispatch to the subtype's implementation or override.
    const subtypes = new Map<string, string[]>();
    const methodsByContainer = new Map<string, Map<string, string>>(); // container -> name -> method id
    for (const edge of edges) {
      if (edge.kind === "Defines") {
        definerOf.set(edge.to, edge.from);
        const member = byId.get(edge.to);
        if (member?.kind === "Method") {
          const byName = methodsByContainer.get(edge.from) ?? new Map<string, string>();
          byName.set(member.name, edge.to);
          methodsByContainer.set(edge.from, byName);
        }
      } else if (edge.kind === "Implements" || edge.kind === "Inherits") {
        const list = subtypes.get(edge.to) ?? [];
        list.push(edge.from);
        subtypes.set(edge.to, list);
      }
    }
    // Overrides: a subtype method of the same name as a supertype method
    // overrides/implements it. Independent of any call — emitted for every such
    // pair, using the same subtype/method maps. (ama-hft.11)
    for (const [superId, subIds] of subtypes) {
      const superMethods = methodsByContainer.get(superId);
      if (!superMethods) continue;
      for (const subId of subIds) {
        const subMethods = methodsByContainer.get(subId);
        if (!subMethods) continue;
        for (const [name, subMethodId] of subMethods) {
          const superMethodId = superMethods.get(name);
          if (superMethodId && superMethodId !== subMethodId) {
            edges.push({ from: subMethodId, to: superMethodId, kind: "Overrides" });
          }
        }
      }
    }

    const fanned: GraphEdge[] = [];
    for (const edge of edges) {
      if (edge.kind !== "Calls") continue;
      const target = byId.get(edge.to);
      if (target?.kind !== "Method") continue;
      const container = definerOf.get(edge.to);
      if (!container) continue;
      const containerKind = byId.get(container)?.kind;
      if (containerKind !== "Interface" && containerKind !== "Class") continue;
      for (const subId of subtypes.get(container) ?? []) {
        const override = methodsByContainer.get(subId)?.get(target.name);
        if (override && override !== edge.to) {
          fanned.push({ from: edge.from, to: override, kind: "Calls" });
        }
      }
    }
    edges.push(...fanned);
  }

  private walkFile(
    sf: ts.SourceFile,
    rel: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
    declToId: Map<ts.Node, string>,
  ): void {
    const id = fileId(rel);
    nodes.push({
      id,
      kind: "File",
      name: path.basename(rel),
      file: rel,
      qualifiedName: "",
      tier: "deep",
      // The whole file, line 1 to EOF — `rangeOf` would skip leading comments
      // (getStart trims trivia), truncating a File snippet's header.
      range: { ...rangeOf(sf, sf), startLine: 1 },
    });
    // Register the file itself so module references (namespace imports,
    // star re-exports) — which alias to the SourceFile — resolve to this node.
    declToId.set(sf, id);
    sf.forEachChild((child) => this.visit(child, sf, rel, id, "", nodes, edges, declToId));
  }

  private visit(
    node: ts.Node,
    sf: ts.SourceFile,
    rel: string,
    containerId: string,
    prefix: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
    declToId: Map<ts.Node, string>,
  ): void {
    // A `const f = () => …` / `= function …` is a VariableStatement wrapping the
    // declaration we actually emit a node for; recurse into its declarations.
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        this.visit(declaration, sf, rel, containerId, prefix, nodes, edges, declToId);
      }
      return;
    }
    const decl = describe(node);
    if (!decl) {
      // `const X = { m() {…}, p: () => {…} }`: X itself isn't a node (there's no
      // object kind), but recurse into its members so function-valued ones become
      // `X.m` Method nodes. Otherwise logic that lives in object literals — every
      // CLI command's `run`, dispatch tables, config handlers — is invisible to
      // the call graph (its calls attribute to nothing).
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        ts.isObjectLiteralExpression(node.initializer) &&
        ts.isIdentifier(node.name)
      ) {
        const objPrefix = prefix ? `${prefix}.${node.name.text}` : node.name.text;
        for (const member of node.initializer.properties) {
          this.visit(member, sf, rel, containerId, objPrefix, nodes, edges, declToId);
        }
      }
      return;
    }

    const qualifiedName = prefix ? `${prefix}.${decl.name}` : decl.name;
    const id = symbolId({ file: rel, qualifiedName });
    nodes.push({
      id,
      kind: decl.kind,
      name: decl.name,
      file: rel,
      qualifiedName,
      tier: "deep",
      range: rangeOf(node, sf),
    });
    edges.push({ from: containerId, to: id, kind: "Defines" });
    declToId.set(node, id);

    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      for (const member of node.members) {
        this.visit(member, sf, rel, id, qualifiedName, nodes, edges, declToId);
      }
    }

    // A namespace/module is a container: recurse into its body so members nest
    // (`Geometry.area`) and don't collide with same-named top-level symbols. The
    // body is a block of statements, or a nested namespace for `namespace A.B`. (ama-hft.13)
    if (ts.isModuleDeclaration(node) && node.body) {
      if (ts.isModuleBlock(node.body)) {
        for (const stmt of node.body.statements) {
          this.visit(stmt, sf, rel, id, qualifiedName, nodes, edges, declToId);
        }
      } else if (ts.isModuleDeclaration(node.body)) {
        this.visit(node.body, sf, rel, id, qualifiedName, nodes, edges, declToId);
      }
    }
  }

  /** Walk a subtree, attributing each call to the nearest enclosing symbol. */
  private collectCalls(
    node: ts.Node,
    enclosingId: string | undefined,
    declToId: Map<ts.Node, string>,
    checker: ts.TypeChecker,
    edges: GraphEdge[],
    root: string,
    counts: ResolutionStats,
  ): void {
    node.forEachChild((child) => {
      // Decorators are usage edges, not calls (collectTypeUsages emits a UsesType
      // edge for each). Skip the whole decorator so `@log()` doesn't masquerade as
      // the decorated symbol calling `log`, and so calls inside decorator arguments
      // (decorator config, not the symbol's behaviour) aren't attributed to it.
      if (ts.isDecorator(child)) return;
      // A `new Foo()` is a construction call site, resolved the same way as a
      // plain call (to Foo's class node), so `find_callers` sees constructions.
      if ((ts.isCallExpression(child) || ts.isNewExpression(child)) && enclosingId) {
        // A call site that can be attributed (has an enclosing function) — count
        // it, and whether it resolved, for the coverage metric. (ama-m8k.12)
        counts.callsTotal++;
        const callee = resolveCallee(child, checker, declToId, root);
        if (callee) {
          counts.callsResolved++;
          // `new X()` is a construction — a distinct Instantiates edge, not Calls.
          const kind = ts.isNewExpression(child) ? "Instantiates" : "Calls";
          edges.push({ from: enclosingId, to: callee, kind, at: locationOf(child) });
        } else {
          // Unresolved — record what it called (by root) so coverage is explainable. (ama-qbn)
          const targetRoot = calleeRoot(child);
          if (targetRoot) counts.unresolved[targetRoot] = (counts.unresolved[targetRoot] ?? 0) + 1;
          // An unresolved higher-order call (arr.map(fn), p.then(handler)) invokes
          // its function argument; attribute a heuristic Calls edge to each named
          // callback, since that control flow is otherwise invisible. (ama-hft.15)
          if (
            ts.isCallExpression(child) &&
            ts.isPropertyAccessExpression(child.expression) &&
            HIGHER_ORDER_METHODS.has(child.expression.name.text)
          ) {
            for (const arg of child.arguments) {
              if (!ts.isIdentifier(arg) && !ts.isPropertyAccessExpression(arg)) continue;
              const cb = resolveValueRef(arg, checker, declToId, root);
              if (cb && cb !== enclosingId) {
                edges.push({
                  from: enclosingId,
                  to: cb,
                  kind: "Calls",
                  provenance: "heuristic",
                  at: locationOf(arg),
                });
              }
            }
          }
        }
      }
      const childId = declToId.get(child);
      // A function-valued `const` is a node (ama-4s2); descending into it makes
      // it the enclosing symbol, so calls in its body attribute to the const.
      // A function-valued object-literal property (ama-zkr) is a node too, so its
      // body's calls attribute to the property rather than leaking to the file.
      // An arrow/function-expression is only enclosing when something registered
      // it in declToId (ama-gpe: inline route handlers) — so ordinary callbacks
      // (.map, .then) stay transparent.
      const nextEnclosing =
        childId &&
        (ts.isFunctionDeclaration(child) ||
          ts.isMethodDeclaration(child) ||
          ts.isConstructorDeclaration(child) ||
          ts.isVariableDeclaration(child) ||
          ts.isPropertyAssignment(child) ||
          ts.isArrowFunction(child) ||
          ts.isFunctionExpression(child))
          ? childId
          : enclosingId;
      this.collectCalls(child, nextEnclosing, declToId, checker, edges, root, counts);
    });
  }

  /**
   * Emit a `References` edge from the enclosing symbol to a module-level Variable
   * node (ama-hft.12) each time its value is read — so `find_callers("MAX_RETRIES")`
   * answers "who reads this constant". Mirrors `collectCalls`' enclosing-tracking.
   *
   * Targets are restricted to `variableIds`, so reads of functions/classes (which
   * are Calls/UsesType, or out of scope) don't become References. Most false
   * positives filter themselves out: a property-access member name resolves to a
   * library member (not in `declToId`), an import specifier sits at top level
   * (no enclosing), and a declaration's own name resolves to the very symbol that
   * encloses it — caught by the `to !== enclosingId` guard. (ama-6k0)
   */
  private collectVarReferences(
    node: ts.Node,
    enclosingId: string | undefined,
    declToId: Map<ts.Node, string>,
    variableIds: Set<string>,
    checker: ts.TypeChecker,
    edges: GraphEdge[],
    root: string,
  ): void {
    node.forEachChild((child) => {
      if (
        ts.isIdentifier(child) &&
        enclosingId &&
        // The member side of `obj.foo` is not an independent value read.
        !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)
      ) {
        const to = resolveValueRef(child, checker, declToId, root);
        if (to && to !== enclosingId && variableIds.has(to)) {
          edges.push({ from: enclosingId, to, kind: "References" });
        }
      }
      const childId = declToId.get(child);
      const nextEnclosing =
        childId &&
        (ts.isFunctionDeclaration(child) ||
          ts.isMethodDeclaration(child) ||
          ts.isConstructorDeclaration(child) ||
          ts.isVariableDeclaration(child) ||
          ts.isPropertyAssignment(child) ||
          ts.isArrowFunction(child) ||
          ts.isFunctionExpression(child))
          ? childId
          : enclosingId;
      this.collectVarReferences(child, nextEnclosing, declToId, variableIds, checker, edges, root);
    });
  }

  /** Walk a subtree emitting an `Implements` edge for each `class … implements I`. */
  private collectHeritage(
    node: ts.Node,
    declToId: Map<ts.Node, string>,
    checker: ts.TypeChecker,
    edges: GraphEdge[],
    root: string,
  ): void {
    if (ts.isClassDeclaration(node)) {
      const from = declToId.get(node);
      for (const clause of node.heritageClauses ?? []) {
        // On a class, `extends` is inheritance; `implements` is interface conformance.
        const kind = clause.token === ts.SyntaxKind.ExtendsKeyword ? "Inherits" : "Implements";
        for (const type of clause.types) {
          const to = from && resolveHeritage(type.expression, checker, declToId, root);
          if (from && to) edges.push({ from, to, kind });
        }
      }
    }
    node.forEachChild((child) => this.collectHeritage(child, declToId, checker, edges, root));
  }

  /**
   * Emit an `Imports` edge from a file to each symbol it imports, and from a
   * re-exporting file (`export { x } from "./m.js"`) to the re-exported symbol.
   * Import/re-export bindings are aliases, so the edge target is the symbol's
   * original declaration — even through a chain of barrels.
   */
  private collectImports(
    sf: ts.SourceFile,
    fromId: string,
    declToId: Map<ts.Node, string>,
    checker: ts.TypeChecker,
    edges: GraphEdge[],
    root: string,
  ): void {
    // Type-only imports/exports (`import type`, `import { type X }`, `export
    // type`) are erased at runtime, so they get an ImportsType edge — counted for
    // dependents/affected but excluded from runtime analyses (circular_imports).
    const link = (name: ts.Node, typeOnly: boolean): void => {
      const to = resolveImport(name, checker, declToId, root);
      if (to) edges.push({ from: fromId, to, kind: typeOnly ? "ImportsType" : "Imports" });
    };
    // Imports can only appear as top-level statements in an ES module.
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && stmt.importClause) {
        const clause = stmt.importClause;
        if (clause.name) link(clause.name, clause.isTypeOnly); // default import
        const { namedBindings } = clause;
        if (namedBindings) {
          if (ts.isNamedImports(namedBindings)) {
            // `import type {…}` makes the whole clause type-only; `import { type X }`
            // marks a single specifier.
            for (const spec of namedBindings.elements) {
              link(spec.name, clause.isTypeOnly || spec.isTypeOnly);
            }
          } else {
            link(namedBindings.name, clause.isTypeOnly); // `import * as ns`
          }
        }
      } else if (
        ts.isExportDeclaration(stmt) &&
        stmt.moduleSpecifier // `export { x }` without a source is a local export, not a re-export
      ) {
        const { exportClause } = stmt;
        if (!exportClause) {
          link(stmt.moduleSpecifier, stmt.isTypeOnly); // `export * from`
        } else if (ts.isNamedExports(exportClause)) {
          for (const spec of exportClause.elements) {
            link(spec.name, stmt.isTypeOnly || spec.isTypeOnly);
          }
        } else {
          link(exportClause.name, stmt.isTypeOnly); // `export * as ns from`
        }
      }
    }
  }

  /**
   * Emit a `UsesType` edge for each named type referenced in a parameter, a
   * function/method return type, a property type, or a generic instantiation's
   * type arguments (`f<Widget>()`, `new Box<Widget>()`, `extends Base<Widget>`),
   * attributed to the nearest enclosing emitted symbol. Composite annotations are
   * walked, so `Widget[]` or `Map<K, Widget>` still link to `Widget`. Types
   * outside the analyzed set (`number`, library types) resolve to no node and are
   * skipped.
   */
  private collectTypeUsages(
    node: ts.Node,
    enclosingId: string | undefined,
    declToId: Map<ts.Node, string>,
    checker: ts.TypeChecker,
    edges: GraphEdge[],
    root: string,
  ): void {
    const annotations: ts.TypeNode[] = [];
    const returnAnnotations: ts.TypeNode[] = []; // → Returns, kept distinct (ama-37c)
    if (
      ts.isParameter(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isVariableDeclaration(node)
    ) {
      if (node.type) annotations.push(node.type);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isGetAccessorDeclaration(node)
    ) {
      if (node.type) returnAnnotations.push(node.type); // return type → Returns
    } else if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isExpressionWithTypeArguments(node)
    ) {
      // Generic instantiation: `f<Widget>()`, `new Box<Widget>()`, `extends Base<Widget>`.
      if (node.typeArguments) annotations.push(...node.typeArguments);
    }
    if (enclosingId) {
      for (const annotation of annotations) {
        for (const ref of typeReferencesIn(annotation)) {
          const to = resolveTypeRef(ref.typeName, checker, declToId, root);
          // A type used inside its own declaration's signature is noise, not a usage.
          if (to && to !== enclosingId) edges.push({ from: enclosingId, to, kind: "UsesType" });
        }
      }
      for (const annotation of returnAnnotations) {
        for (const ref of typeReferencesIn(annotation)) {
          const to = resolveTypeRef(ref.typeName, checker, declToId, root);
          if (to && to !== enclosingId) edges.push({ from: enclosingId, to, kind: "Returns" });
        }
      }
      // A decorator is a metadata/annotation dependency of the decorated symbol —
      // modelled as UsesType (decorated → decorator), uniformly for call-form
      // (`@log()`) and bare (`@sealed`) decorators. So `find_type_users(Component)`
      // answers "what is decorated by @Component?".
      if (ts.canHaveDecorators(node)) {
        for (const decorator of ts.getDecorators(node) ?? []) {
          const ref = ts.isCallExpression(decorator.expression)
            ? decorator.expression.expression
            : decorator.expression;
          const to = resolveValueRef(ref, checker, declToId, root);
          if (to && to !== enclosingId) edges.push({ from: enclosingId, to, kind: "UsesType" });
        }
      }
    }
    node.forEachChild((child) => {
      const childId = declToId.get(child);
      this.collectTypeUsages(child, childId ?? enclosingId, declToId, checker, edges, root);
    });
  }

  /**
   * Detect framework routes (Express/NestJS-style call APIs: `app.get("/x", h)`,
   * `router.post(...)`) and emit a Route node per route, plus a References edge to
   * each named handler. Deliberately scoped to avoid false positives: an HTTP-verb
   * method call whose first arg is a "/"-prefixed string literal and which has at
   * least one handler arg (so `map.get("k")` / `headers.get("x")` don't match).
   * Inline arrow/function handlers get a Route node but no edge yet — naming an
   * anonymous handler is the arg-position-handler follow-up (ama-y9q).
   */
  private collectRoutes(
    sf: ts.SourceFile,
    rel: string,
    declToId: Map<ts.Node, string>,
    checker: ts.TypeChecker,
    nodes: GraphNode[],
    edges: GraphEdge[],
    root: string,
    mountPrefixes: Map<ts.Node, string>,
  ): void {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text.toLowerCase();
        const [first, ...rest] = n.arguments;
        const handlers = rest.filter(
          (a) =>
            ts.isArrowFunction(a) ||
            ts.isFunctionExpression(a) ||
            ts.isIdentifier(a) ||
            ts.isPropertyAccessExpression(a),
        );
        if (
          ROUTE_METHODS.has(method) &&
          first !== undefined &&
          ts.isStringLiteralLike(first) &&
          first.text.startsWith("/") &&
          handlers.length > 0
        ) {
          // If this route's receiver is a router mounted under a prefix, prepend it.
          const receiverDecl = valueDeclOf(n.expression.expression, checker);
          const prefix = receiverDecl ? mountPrefixes.get(receiverDecl) : undefined;
          const name = `${method.toUpperCase()} ${joinRoutePath(prefix, first.text)}`;
          const routeId = symbolId({ file: rel, qualifiedName: name });
          nodes.push({
            id: routeId,
            kind: "Route",
            name,
            file: rel,
            qualifiedName: name,
            tier: "deep",
            range: rangeOf(n, sf),
          });
          this.emitRouteHandlers(
            routeId,
            name,
            handlers,
            rel,
            sf,
            declToId,
            checker,
            nodes,
            edges,
            root,
          );
        }
      }
      // Object-config routes: Hapi `server.route({ method, path, handler })` and
      // Fastify `fastify.route({ method, url, handler })` (also `.route([{…}])`).
      // The method-named path above already covers the `app.get(path, h)` style
      // that Fastify/Koa/Hono share with Express. (ama-rme.10)
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "route"
      ) {
        const arg = n.arguments[0];
        const configs = arg ? (ts.isArrayLiteralExpression(arg) ? arg.elements : [arg]) : [];
        for (const config of configs) {
          if (!ts.isObjectLiteralExpression(config)) continue;
          const methods = routeMethods(objectProp(config, "method"));
          const pathExpr = objectProp(config, "path") ?? objectProp(config, "url");
          const handler = objectProp(config, "handler");
          if (methods.length === 0 || !pathExpr || !ts.isStringLiteralLike(pathExpr) || !handler) {
            continue;
          }
          if (!pathExpr.text.startsWith("/")) continue;
          for (const method of methods) {
            const name = `${method.toUpperCase()} ${pathExpr.text}`;
            const routeId = symbolId({ file: rel, qualifiedName: name });
            nodes.push({
              id: routeId,
              kind: "Route",
              name,
              file: rel,
              qualifiedName: name,
              tier: "deep",
              range: rangeOf(config, sf),
            });
            this.emitRouteHandlers(
              routeId,
              name,
              [handler],
              rel,
              sf,
              declToId,
              checker,
              nodes,
              edges,
              root,
            );
          }
        }
      }
      // tRPC: a router property `name: <chain>.query/mutation/subscription(handler)`.
      // The property key is the procedure name; the call's first arg is the
      // handler. (ama-rme.11)
      if (
        ts.isPropertyAssignment(n) &&
        ts.isIdentifier(n.name) &&
        ts.isCallExpression(n.initializer) &&
        ts.isPropertyAccessExpression(n.initializer.expression) &&
        PROCEDURE_TYPES.has(n.initializer.expression.name.text)
      ) {
        const handler = n.initializer.arguments[0];
        if (handler && isHandlerExpr(handler)) {
          const name = `${n.initializer.expression.name.text} ${n.name.text}`;
          const routeId = symbolId({ file: rel, qualifiedName: name });
          nodes.push({
            id: routeId,
            kind: "Route",
            name,
            file: rel,
            qualifiedName: name,
            tier: "deep",
            range: rangeOf(n, sf),
          });
          this.emitRouteHandlers(
            routeId,
            name,
            [handler],
            rel,
            sf,
            declToId,
            checker,
            nodes,
            edges,
            root,
          );
        }
      }
      // GraphQL: a resolver map `{ Query: { field: resolver }, Mutation: {…} }` —
      // each field under a Query/Mutation/Subscription root is a `Type.field`
      // route referencing its resolver. (ama-rme.11)
      if (ts.isObjectLiteralExpression(n)) {
        for (const typeProp of n.properties) {
          if (
            !ts.isPropertyAssignment(typeProp) ||
            !ts.isIdentifier(typeProp.name) ||
            !GRAPHQL_ROOTS.has(typeProp.name.text) ||
            !ts.isObjectLiteralExpression(typeProp.initializer)
          ) {
            continue;
          }
          for (const field of typeProp.initializer.properties) {
            if (
              !ts.isPropertyAssignment(field) ||
              !ts.isIdentifier(field.name) ||
              !isHandlerExpr(field.initializer)
            ) {
              continue;
            }
            const name = `${typeProp.name.text}.${field.name.text}`;
            const routeId = symbolId({ file: rel, qualifiedName: name });
            nodes.push({
              id: routeId,
              kind: "Route",
              name,
              file: rel,
              qualifiedName: name,
              tier: "deep",
              range: rangeOf(field, sf),
            });
            this.emitRouteHandlers(
              routeId,
              name,
              [field.initializer],
              rel,
              sf,
              declToId,
              checker,
              nodes,
              edges,
              root,
            );
          }
        }
      }
      // NestJS: @Controller("prefix") class whose methods carry @Get/@Post/...
      // decorators. The decorated method IS the handler (already a Method node);
      // the route path is the controller prefix joined with the method's path.
      if (ts.isClassDeclaration(n) && ts.canHaveDecorators(n)) {
        const controller = (ts.getDecorators(n) ?? [])
          .map(decoratorInfo)
          .find((d) => d.name === "Controller");
        if (controller) {
          for (const member of n.members) {
            if (!ts.isMethodDeclaration(member) || !ts.canHaveDecorators(member)) continue;
            const handlerId = declToId.get(member);
            if (handlerId === undefined) continue;
            for (const dec of ts.getDecorators(member) ?? []) {
              const info = decoratorInfo(dec);
              if (!ROUTE_METHODS.has(info.name.toLowerCase())) continue;
              const name = `${info.name.toUpperCase()} ${joinRoutePath(controller.arg, info.arg)}`;
              const routeId = symbolId({ file: rel, qualifiedName: name });
              nodes.push({
                id: routeId,
                kind: "Route",
                name,
                file: rel,
                qualifiedName: name,
                tier: "deep",
                range: rangeOf(member, sf),
              });
              edges.push({
                from: routeId,
                to: handlerId,
                kind: "References",
                provenance: "heuristic",
              });
            }
          }
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }

  /**
   * Wire a route to its handler argument(s): an inline arrow/function becomes a
   * synthesized handler Function node (named by the route, registered so its body
   * attributes to it), while a named handler reference resolves to its node. Each
   * gets a heuristic References edge from the route. Shared by every route style.
   * (ama-rme.1, ama-rme.10)
   */
  private emitRouteHandlers(
    routeId: string,
    name: string,
    handlers: readonly ts.Expression[],
    rel: string,
    sf: ts.SourceFile,
    declToId: Map<ts.Node, string>,
    checker: ts.TypeChecker,
    nodes: GraphNode[],
    edges: GraphEdge[],
    root: string,
  ): void {
    let inlineCount = 0;
    for (const handler of handlers) {
      if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
        const handlerName = `${name} handler${inlineCount === 0 ? "" : ` ${inlineCount + 1}`}`;
        inlineCount++;
        const handlerId = symbolId({ file: rel, qualifiedName: handlerName });
        nodes.push({
          id: handlerId,
          kind: "Function",
          name: handlerName,
          file: rel,
          qualifiedName: handlerName,
          tier: "deep",
          range: rangeOf(handler, sf),
        });
        declToId.set(handler, handlerId);
        edges.push({ from: routeId, to: handlerId, kind: "References", provenance: "heuristic" });
        continue;
      }
      const to = resolveValueRef(handler, checker, declToId, root);
      if (to && to !== routeId) {
        edges.push({ from: routeId, to, kind: "References", provenance: "heuristic" });
      }
    }
  }

  /**
   * Synthesize a Function node for an inline arrow/function-expression passed as an
   * argument to a *string-named* call whose result is itself consumed —
   * `register("work", wrap("work", () => …))`. The leading string literal names the
   * node (`"work handler"`); registering the arrow in `declToId` before
   * `collectCalls` makes the callback body's calls attribute to it instead of
   * leaking to the enclosing function (so per-handler blast radius is precise).
   *
   * Runs after `collectRoutes`, so a route's inline handler — already registered —
   * is skipped. The "result is consumed" gate (the call is not a bare expression
   * statement) is what separates a handler-producing wrapper like `tap(name, fn)`
   * from a fire-and-forget test block like `it(name, fn)` / `describe(name, fn)`:
   * only the former becomes a node, so the graph isn't flooded with one node per
   * test case. (ama-y9q)
   *
   * The handler need not be a *direct* argument: it may be nested inside a second
   * wrapper whose own first argument is not a string — `tap("search",
   * queryTool(session, () => …))`. `collectHandlerArrows` digs through such
   * wrapper-call arguments (stopping at the first function, so a handler's body is
   * never mistaken for another handler), keying every one by the outer name. (ama-63x)
   */
  private collectCallbackHandlers(
    node: ts.Node,
    enclosingId: string | undefined,
    rel: string,
    sf: ts.SourceFile,
    declToId: Map<ts.Node, string>,
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): void {
    node.forEachChild((child) => {
      const first = ts.isCallExpression(child) ? child.arguments[0] : undefined;
      if (
        ts.isCallExpression(child) &&
        !ts.isExpressionStatement(child.parent) &&
        first !== undefined &&
        ts.isStringLiteralLike(first)
      ) {
        let inlineCount = 0;
        for (const arg of collectHandlerArrows(child.arguments)) {
          if (declToId.has(arg)) continue; // already a node (e.g. a route handler)
          const handlerName = `${first.text} handler${inlineCount === 0 ? "" : ` ${inlineCount + 1}`}`;
          inlineCount++;
          const handlerId = symbolId({ file: rel, qualifiedName: handlerName });
          nodes.push({
            id: handlerId,
            kind: "Function",
            name: handlerName,
            file: rel,
            qualifiedName: handlerName,
            tier: "deep",
            range: rangeOf(arg, sf),
          });
          declToId.set(arg, handlerId);
          if (enclosingId) {
            edges.push({
              from: enclosingId,
              to: handlerId,
              kind: "References",
              provenance: "heuristic",
            });
          }
        }
      }
      const childId = declToId.get(child);
      // Mirror collectCalls' enclosing rule so a synthesized handler nested inside
      // another becomes the `from` of the inner one's reference edge.
      const nextEnclosing =
        childId &&
        (ts.isFunctionDeclaration(child) ||
          ts.isMethodDeclaration(child) ||
          ts.isConstructorDeclaration(child) ||
          ts.isVariableDeclaration(child) ||
          ts.isPropertyAssignment(child) ||
          ts.isArrowFunction(child) ||
          ts.isFunctionExpression(child))
          ? childId
          : enclosingId;
      this.collectCallbackHandlers(child, nextEnclosing, rel, sf, declToId, nodes, edges);
    });
  }

  /**
   * File-based routing: a route file at a framework convention path exports HTTP
   * method handlers and the URL comes from the *path* (not a call). Next.js App
   * Router (`app/**​/route.ts`) and SvelteKit (`src/routes/**​/+server.ts`) — each
   * exported `GET`/`POST`/… function becomes a `<METHOD> <path>` Route referencing
   * it. Heuristic: the route is inferred from filesystem convention. (ama-rme.7)
   */
  private collectFileRoutes(
    sf: ts.SourceFile,
    rel: string,
    declToId: Map<ts.Node, string>,
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): void {
    const routePath = fileRoutePath(rel);
    if (routePath === undefined) return;
    const emit = (methodName: string, decl: ts.Node): void => {
      if (!ROUTE_METHODS.has(methodName.toLowerCase())) return;
      const handlerId = declToId.get(decl);
      if (!handlerId) return;
      const name = `${methodName} ${routePath}`;
      const routeId = symbolId({ file: rel, qualifiedName: name });
      nodes.push({
        id: routeId,
        kind: "Route",
        name,
        file: rel,
        qualifiedName: name,
        tier: "deep",
        range: rangeOf(decl, sf),
      });
      edges.push({ from: routeId, to: handlerId, kind: "References", provenance: "heuristic" });
    };
    for (const stmt of sf.statements) {
      if (!isExported(stmt)) continue;
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        emit(stmt.name.text, stmt);
      } else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (
            ts.isIdentifier(d.name) &&
            d.initializer &&
            (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
          ) {
            emit(d.name.text, d);
          }
        }
      }
    }
  }

  /**
   * Synthesize call edges for the EventEmitter pattern: an `emitter.emit("ch")`
   * invokes every handler registered with `.on("ch", h)` (or once/addListener)
   * for the same channel string. Heuristic — matched by channel name, not proven
   * dispatch — so the synthesized edges carry `provenance: "heuristic"`. Runs
   * after collectCallbackHandlers so inline `.on("ch", () => …)` arrows (already
   * synthesized into handler nodes there) are connectable too. (ama-hft.14)
   */
  private collectEvents(
    sf: ts.SourceFile,
    declToId: Map<ts.Node, string>,
    checker: ts.TypeChecker,
    edges: GraphEdge[],
    root: string,
  ): void {
    // Pass 1: channel -> the handler node(s) registered for it.
    const handlers = new Map<string, string[]>();
    const collectRegistrations = (node: ts.Node): void => {
      node.forEachChild((child) => {
        if (
          ts.isCallExpression(child) &&
          ts.isPropertyAccessExpression(child.expression) &&
          ON_METHODS.has(child.expression.name.text)
        ) {
          const [channel, handler] = child.arguments;
          if (channel && ts.isStringLiteralLike(channel) && handler) {
            const handlerId = eventHandlerId(handler, declToId, checker, root);
            if (handlerId) {
              const list = handlers.get(channel.text) ?? [];
              list.push(handlerId);
              handlers.set(channel.text, list);
            }
          }
        }
        collectRegistrations(child);
      });
    };
    collectRegistrations(sf);
    if (handlers.size === 0) return; // nothing listens — no edges to synthesize

    // Pass 2: each `emit("ch")` calls every handler registered for "ch".
    const collectEmits = (node: ts.Node, enclosingId: string | undefined): void => {
      node.forEachChild((child) => {
        if (
          enclosingId &&
          ts.isCallExpression(child) &&
          ts.isPropertyAccessExpression(child.expression) &&
          child.expression.name.text === "emit"
        ) {
          const channel = child.arguments[0];
          if (channel && ts.isStringLiteralLike(channel)) {
            for (const handlerId of handlers.get(channel.text) ?? []) {
              if (handlerId !== enclosingId) {
                edges.push({
                  from: enclosingId,
                  to: handlerId,
                  kind: "Calls",
                  provenance: "heuristic",
                  at: locationOf(child),
                });
              }
            }
          }
        }
        const childId = declToId.get(child);
        const nextEnclosing =
          childId &&
          (ts.isFunctionDeclaration(child) ||
            ts.isMethodDeclaration(child) ||
            ts.isConstructorDeclaration(child) ||
            ts.isVariableDeclaration(child) ||
            ts.isPropertyAssignment(child) ||
            ts.isArrowFunction(child) ||
            ts.isFunctionExpression(child))
            ? childId
            : enclosingId;
        collectEmits(child, nextEnclosing);
      });
    };
    collectEmits(sf, undefined);
  }

  /**
   * Find Express mounts — `app.use("/prefix", router, …)` — and map each mounted
   * argument's declaration to the prefix. Runs over every file before route
   * detection so a router defined in one file and mounted in another composes.
   */
  private collectMounts(
    sf: ts.SourceFile,
    checker: ts.TypeChecker,
    mountPrefixes: Map<ts.Node, string>,
  ): void {
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "use"
      ) {
        const [first, ...rest] = n.arguments;
        if (first !== undefined && ts.isStringLiteralLike(first) && first.text.startsWith("/")) {
          for (const arg of rest) {
            if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) {
              const decl = valueDeclOf(arg, checker);
              // Harmless if `arg` is middleware, not a router: it just won't have routes.
              if (decl) mountPrefixes.set(decl, first.text);
            }
          }
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
}

/** HTTP-verb methods that mark an Express/Nest-style route registration call. */
const ROUTE_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head", "all"]);

/** A decorator's callee name and its first string-literal argument, if any. */
function decoratorInfo(dec: ts.Decorator): { name: string; arg: string | undefined } {
  const expr = dec.expression;
  const callee = ts.isCallExpression(expr) ? expr.expression : expr;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : "";
  let arg: string | undefined;
  if (ts.isCallExpression(expr)) {
    const first = expr.arguments[0];
    if (first && ts.isStringLiteralLike(first)) arg = first.text;
  }
  return { name, arg };
}

/** The value declaration an expression resolves to (alias-followed), or undefined. */
function valueDeclOf(expr: ts.Expression, checker: ts.TypeChecker): ts.Node | undefined {
  let symbol = checker.getSymbolAtLocation(expr);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

/**
 * The inline handler callbacks reachable from a registration call's arguments:
 * direct arrow/function args, plus arrows nested inside wrapper calls —
 * `tap("name", queryTool(session, () => …))`. Descends through call-argument
 * positions but stops at the first function in each branch: an arrow's body is its
 * own scope (its `.map`/`.then` callbacks are not handlers), and the wrapper's
 * non-call args (`session`) carry nothing. (ama-63x)
 */
function collectHandlerArrows(
  args: readonly ts.Expression[],
): (ts.ArrowFunction | ts.FunctionExpression)[] {
  const out: (ts.ArrowFunction | ts.FunctionExpression)[] = [];
  const dig = (expr: ts.Expression): void => {
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
      out.push(expr); // a handler — do not descend into its body
      return;
    }
    if (ts.isCallExpression(expr)) {
      for (const a of expr.arguments) dig(a);
    }
  };
  for (const a of args) dig(a);
  return out;
}

/** Join a controller prefix and a method sub-path into a leading-slash route path. */
function joinRoutePath(prefix: string | undefined, sub: string | undefined): string {
  const parts = [prefix, sub]
    .filter((p): p is string => p !== undefined && p.length > 0)
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0);
  return `/${parts.join("/")}`;
}

/** Map a declaration node to a (kind, name) pair, or undefined if it isn't one. */
function describe(node: ts.Node): { kind: NodeKind; name: string } | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) {
    const component = isComponentName(node.name.text) && returnsJsx(node);
    return { kind: component ? "Component" : "Function", name: node.name.text };
  }
  if (ts.isClassDeclaration(node) && node.name) {
    return { kind: "Class", name: node.name.text };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return { kind: "Interface", name: node.name.text };
  }
  if (ts.isEnumDeclaration(node)) {
    return { kind: "Enum", name: node.name.text };
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return { kind: "TypeAlias", name: node.name.text };
  }
  // A `namespace N {}` / `module N {}` or an ambient `declare module "pkg" {}` —
  // the declared-but-never-emitted Module kind. The name is an Identifier
  // (namespace) or a StringLiteral (ambient module); both expose `.text`. (ama-hft.13)
  if (ts.isModuleDeclaration(node)) {
    return { kind: "Module", name: node.name.text };
  }
  if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && ts.isIdentifier(node.name)) {
    return { kind: "Method", name: node.name.text };
  }
  // A constructor is a Method named "constructor" (qualified `Cls.constructor`),
  // so its body's wiring — calls, references, param-type usages — attributes to it
  // instead of being dropped at the class boundary. (ama-vz8)
  if (ts.isConstructorDeclaration(node)) {
    return { kind: "Method", name: "constructor" };
  }
  if (
    (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) &&
    ts.isIdentifier(node.name)
  ) {
    return { kind: "Property", name: node.name.text };
  }
  if (
    (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
    ts.isIdentifier(node.name)
  ) {
    // A get/set pair shares one member name -> one Property node (ids dedup).
    return { kind: "Property", name: node.name.text };
  }
  if (
    ts.isVariableDeclaration(node) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
    ts.isIdentifier(node.name)
  ) {
    const component = isComponentName(node.name.text) && returnsJsx(node.initializer);
    return { kind: component ? "Component" : "Function", name: node.name.text };
  }
  // A Vue component: `const X = defineComponent({ … })`. Before the Variable
  // catch-all (its initializer is a call, not an object literal). (ama-rme.9)
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined &&
    ts.isCallExpression(node.initializer) &&
    isDefineComponentCall(node.initializer)
  ) {
    return { kind: "Component", name: node.name.text };
  }
  // A function-valued object-literal property (`{ run: () => … }`) — a method in
  // all but syntax. Method shorthand (`{ run() {} }`) is already a MethodDeclaration.
  if (
    ts.isPropertyAssignment(node) &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
    ts.isIdentifier(node.name)
  ) {
    return { kind: "Method", name: node.name.text };
  }
  // Any other module-level variable binding (`const MAX_RETRIES = 3`, `const SET =
  // new Set(...)`, `const LABELS = [...] as const`) — a Variable node so it's
  // searchable, snippet-able, and listed in a file's outline. Function-valued and
  // object-literal initializers are handled above / by `visit` (their members
  // become nodes; the object const itself stays a non-node, the ama-zkr rule).
  // `visit` only reaches top-level / class-member / object-member declarations, so
  // locals inside function bodies never become Variable nodes.
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    !(node.initializer !== undefined && ts.isObjectLiteralExpression(node.initializer))
  ) {
    return { kind: "Variable", name: node.name.text };
  }
  return undefined;
}

/**
 * Resolve a call's callee to a graph node id, following import aliases. Accepts
 * a `new` expression too: its `.expression` is the constructed class, which
 * resolves the same way (so construction counts as a call site).
 */
/** Collapse repeated Calls/Instantiates edges between the same (from, to) into a
 *  single edge that records *every* call site in `sites`, so find_callers/callees
 *  can report all of them rather than just the first the store would keep. Other
 *  edge kinds pass through untouched. (ama-hft.10) */
function accumulateCallSites(edges: GraphEdge[]): GraphEdge[] {
  const callEdges = new Map<string, GraphEdge>();
  const result: GraphEdge[] = [];
  for (const edge of edges) {
    if (edge.kind !== "Calls" && edge.kind !== "Instantiates") {
      result.push(edge);
      continue;
    }
    const key = `${edge.from} ${edge.to} ${edge.kind}`;
    const existing = callEdges.get(key);
    if (!existing) {
      callEdges.set(key, edge);
      result.push(edge);
    } else if (edge.at) {
      if (!existing.at) existing.at = edge.at;
      else {
        existing.sites ??= [existing.at];
        existing.sites.push(edge.at);
      }
    }
  }
  return result;
}

/** Built-in higher-order methods that invoke a function argument — Array
 *  iteration and Promise chaining. A named function passed to one of these is
 *  attributed a heuristic Calls edge (the method name is a pattern match, not a
 *  proof it calls the arg, hence heuristic). (ama-hft.15) */
const HIGHER_ORDER_METHODS = new Set([
  "map",
  "forEach",
  "filter",
  "reduce",
  "reduceRight",
  "flatMap",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "sort",
  "then",
  "catch",
  "finally",
]);

/** EventEmitter registration methods: `.on/.once/.addListener("ch", handler)` and
 *  their prepend variants all bind a handler to a channel. (ama-hft.14) */
const ON_METHODS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);

/** The node a `.on("ch", handler)` argument refers to: a named function/method
 *  (resolved via the checker) or an inline arrow already synthesized into a
 *  handler node by collectCallbackHandlers. (ama-hft.14) */
function eventHandlerId(
  arg: ts.Expression,
  declToId: Map<ts.Node, string>,
  checker: ts.TypeChecker,
  root: string,
): string | undefined {
  if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) {
    return resolveValueRef(arg, checker, declToId, root);
  }
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    return declToId.get(arg);
  }
  return undefined;
}

/** The initializer of an object-literal property by key — reads route-config
 *  fields (method/path/url/handler) for object-style routing. (ama-rme.10) */
function objectProp(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === key) {
      return prop.initializer;
    }
  }
  return undefined;
}

/** HTTP method(s) from a route config's `method` value — a single string ("GET")
 *  or an array (["GET", "POST"]). (ama-rme.10) */
function routeMethods(expr: ts.Expression | undefined): string[] {
  if (!expr) return [];
  if (ts.isStringLiteralLike(expr)) return [expr.text];
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.filter(ts.isStringLiteralLike).map((e) => e.text);
  }
  return [];
}

/** tRPC procedure builders — a router property `key: proc.query(handler)`. (ama-rme.11) */
const PROCEDURE_TYPES = new Set(["query", "mutation", "subscription"]);

/** GraphQL root types in a resolver map. (ama-rme.11) */
const GRAPHQL_ROOTS = new Set(["Query", "Mutation", "Subscription"]);

/** Whether an expression looks like a route/resolver handler — an inline
 *  function or a reference to one. Excludes string/config args so `db.query(sql)`
 *  isn't mistaken for a tRPC procedure. (ama-rme.11) */
function isHandlerExpr(expr: ts.Expression): boolean {
  return (
    ts.isArrowFunction(expr) ||
    ts.isFunctionExpression(expr) ||
    ts.isIdentifier(expr) ||
    ts.isPropertyAccessExpression(expr)
  );
}

/** Convert a file-route directory segment to a URL segment: `[id]` → `:id`,
 *  `[...slug]` → `*`, `[[opt]]` → `:opt`; a `(group)` is dropped (no URL effect);
 *  else verbatim. (ama-rme.7) */
function routeSegment(seg: string): string | undefined {
  if (seg.startsWith("(") && seg.endsWith(")")) return undefined;
  if (seg.startsWith("[...") && seg.endsWith("]")) return "*";
  if (seg.startsWith("[[") && seg.endsWith("]]")) return `:${seg.slice(2, -2)}`;
  if (seg.startsWith("[") && seg.endsWith("]")) return `:${seg.slice(1, -1)}`;
  return seg;
}

/** The URL path a file-based route file maps to, or undefined if it isn't one:
 *  Next.js App Router `app/**​/route.ts` and SvelteKit `src/routes/**​/+server.ts`
 *  — the path is the directories between the routes root and the marker file. (ama-rme.7) */
function fileRoutePath(rel: string): string | undefined {
  const parts = rel.split("/");
  const file = parts[parts.length - 1] ?? "";
  let rootIdx = -1;
  if (file.startsWith("route.")) rootIdx = parts.lastIndexOf("app");
  else if (file.startsWith("+server.")) rootIdx = parts.lastIndexOf("routes");
  if (rootIdx < 0) return undefined;
  const segs = parts
    .slice(rootIdx + 1, parts.length - 1)
    .map(routeSegment)
    .filter((s): s is string => s !== undefined);
  return `/${segs.join("/")}`;
}

/** Whether a top-level statement carries an `export` modifier. (ama-rme.7) */
function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** React requires a component name to be capitalized (so JSX `<Foo/>` isn't a host
 *  element). Used to tell a JSX-returning component from a render helper. (ama-rme.9) */
function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** Whether an expression is a JSX element/fragment (through parentheses). (ama-rme.9) */
function isJsxLike(expr: ts.Expression): boolean {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return ts.isJsxElement(e) || ts.isJsxFragment(e) || ts.isJsxSelfClosingElement(e);
}

/** Whether a function returns JSX — an arrow with a JSX concise body, or any
 *  `return <jsx>` in its block (not counting nested functions). (ama-rme.9) */
function returnsJsx(
  fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
): boolean {
  if (ts.isArrowFunction(fn) && fn.body && !ts.isBlock(fn.body)) return isJsxLike(fn.body);
  if (!fn.body) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isReturnStatement(n) && n.expression && isJsxLike(n.expression)) {
      found = true;
      return;
    }
    // A nested function/class has its own returns — don't attribute them here.
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isClassDeclaration(n)
    ) {
      return;
    }
    n.forEachChild(visit);
  };
  visit(fn.body);
  return found;
}

/** Whether a call is `defineComponent(...)` — Vue's component factory. (ama-rme.9) */
function isDefineComponentCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "defineComponent";
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "defineComponent";
  return false;
}

/** The leftmost identifier of a call's callee — `ts` for `ts.isCallExpression(x)`,
 *  `helper` for `helper()` — used to group unresolved calls by what they target
 *  (a module/object name). `this.X...` groups by `X` (the property/method on
 *  `this`), since the bare `this` root is opaque about where the call is — most of
 *  these are builtin calls on instance fields like `this.items.push()`. Undefined
 *  for call results, super(), etc. (ama-qbn, ama-k9t) */
function calleeRoot(call: ts.CallExpression | ts.NewExpression): string | undefined {
  let e: ts.Node = call.expression;
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    if (e.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return ts.isPropertyAccessExpression(e) ? e.name.text : undefined;
    }
    e = e.expression;
  }
  if (ts.isIdentifier(e)) return e.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return "this";
  return undefined;
}

function resolveCallee(
  call: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
  root: string,
): string | undefined {
  let symbol = checker.getSymbolAtLocation(call.expression);
  if (!symbol) {
    const decl = checker.getResolvedSignature(call)?.declaration;
    return decl ? (declToId.get(decl) ?? nodeIdForDecl(decl, root)) : undefined;
  }
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return decl ? (declToId.get(decl) ?? nodeIdForDecl(decl, root)) : undefined;
}

/** Resolve a value-position reference (e.g. a decorator's `@Foo`) to a node id. */
function resolveValueRef(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
  root: string,
): string | undefined {
  let symbol = checker.getSymbolAtLocation(expr);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return decl ? (declToId.get(decl) ?? nodeIdForDecl(decl, root)) : undefined;
}

/** Resolve a heritage type reference (e.g. the `I` in `implements I`) to a node id. */
function resolveHeritage(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
  root: string,
): string | undefined {
  let symbol = checker.getSymbolAtLocation(expr);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  // Interfaces are type-only, so they have no valueDeclaration — use declarations.
  const decl = symbol.declarations?.[0];
  return decl ? (declToId.get(decl) ?? nodeIdForDecl(decl, root)) : undefined;
}

/** Resolve an imported or re-exported name to its original declaration's node id. */
function resolveImport(
  name: ts.Node,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
  root: string,
): string | undefined {
  let symbol = checker.getSymbolAtLocation(name);
  if (!symbol) return undefined;
  // Import/re-export bindings are aliases; follow the chain to the real declaration.
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return decl ? (declToId.get(decl) ?? nodeIdForDecl(decl, root)) : undefined;
}

/** Resolve a type reference's name (e.g. the `Foo` in `x: Foo`) to a node id. */
function resolveTypeRef(
  name: ts.EntityName,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
  root: string,
): string | undefined {
  let symbol = checker.getSymbolAtLocation(name);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  // Types are usually type-only (no valueDeclaration), so prefer declarations.
  const decl = symbol.declarations?.[0] ?? symbol.valueDeclaration;
  return decl ? (declToId.get(decl) ?? nodeIdForDecl(decl, root)) : undefined;
}

/**
 * The graph id a declaration *would* receive from a structural walk, computed
 * from its location alone. This lets resolution target a node in a file the
 * current pass never walked — the cross-file case during single-file
 * re-indexing, where `declToId` only holds the one changed file. Returns
 * undefined for declarations a walk would not emit (nested functions, library
 * code outside `root`), so the graph never asserts an edge it cannot back.
 *
 * It mirrors {@link visit}'s reachability exactly: a node exists only as a
 * top-level declaration, or as a member of a top-level class/interface.
 */
function nodeIdForDecl(node: ts.Node, root: string): string | undefined {
  // Module references (namespace imports / star re-exports) target the File node.
  if (ts.isSourceFile(node)) {
    const rel = repoRel(root, node.fileName);
    return rel === undefined ? undefined : fileId(rel);
  }
  const self = describe(node);
  if (!self) return undefined;
  const rel = repoRel(root, node.getSourceFile().fileName);
  if (rel === undefined) return undefined;
  const parent = node.parent;
  if (parent && ts.isSourceFile(parent)) {
    return symbolId({ file: rel, qualifiedName: self.name });
  }
  if (
    parent &&
    (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) &&
    parent.name &&
    parent.parent &&
    ts.isSourceFile(parent.parent)
  ) {
    return symbolId({ file: rel, qualifiedName: `${parent.name.text}.${self.name}` });
  }
  return undefined;
}

/** Repo-relative path of an absolute file, or undefined if it falls outside the
 * indexed tree (a different package, or `node_modules`). */
function repoRel(root: string, fileName: string): string | undefined {
  const rel = path.relative(root, fileName);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  if (rel.split(path.sep).includes("node_modules")) return undefined;
  return rel;
}

/** Every type reference within a type annotation, including those nested in
 * arrays, unions, and generic type arguments (so `Map<K, Foo>` yields `Foo`). */
function typeReferencesIn(node: ts.TypeNode): ts.TypeReferenceNode[] {
  const refs: ts.TypeReferenceNode[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isTypeReferenceNode(n)) refs.push(n);
    n.forEachChild(walk);
  };
  walk(node);
  return refs;
}

function rangeOf(node: ts.Node, sf: ts.SourceFile): SourceRange {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return { startLine: start.line + 1, endLine: end.line + 1 };
}

/** A node's 1-based (line, column) start — for tagging an edge with its source
 *  site (a call/new expression's position). (ama-hft.9) */
function locationOf(node: ts.Node): { line: number; column: number } {
  const sf = node.getSourceFile();
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, column: character + 1 };
}
