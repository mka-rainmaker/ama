import * as path from "node:path";
import ts from "typescript";
import { fileId, symbolId } from "../../graph/index.js";
import type { GraphEdge, GraphNode, NodeKind, SourceRange } from "../../graph/index.js";
import type { AnalysisResult, Analyzer } from "../types.js";

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

    for (const [abs, rel] of relByAbs) {
      const sf = program.getSourceFile(abs);
      if (sf) {
        // Routes first: it registers inline-handler arrows in declToId, so the
        // following collectCalls attributes each handler's body to its node.
        this.collectRoutes(sf, rel, declToId, checker, nodes, edges, root, mountPrefixes);
        this.collectCalls(sf, undefined, declToId, checker, edges, root);
        this.collectHeritage(sf, declToId, checker, edges, root);
        this.collectTypeUsages(sf, undefined, declToId, checker, edges, root);
        this.collectImports(sf, fileId(rel), declToId, checker, edges, root);
      }
    }

    this.resolveDispatch(nodes, edges);
    return { nodes, edges };
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
  }

  /** Walk a subtree, attributing each call to the nearest enclosing symbol. */
  private collectCalls(
    node: ts.Node,
    enclosingId: string | undefined,
    declToId: Map<ts.Node, string>,
    checker: ts.TypeChecker,
    edges: GraphEdge[],
    root: string,
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
        const callee = resolveCallee(child, checker, declToId, root);
        if (callee) edges.push({ from: enclosingId, to: callee, kind: "Calls" });
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
          ts.isVariableDeclaration(child) ||
          ts.isPropertyAssignment(child) ||
          ts.isArrowFunction(child) ||
          ts.isFunctionExpression(child))
          ? childId
          : enclosingId;
      this.collectCalls(child, nextEnclosing, declToId, checker, edges, root);
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
    const link = (name: ts.Node): void => {
      const to = resolveImport(name, checker, declToId, root);
      if (to) edges.push({ from: fromId, to, kind: "Imports" });
    };
    // Imports can only appear as top-level statements in an ES module.
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && stmt.importClause) {
        const { name, namedBindings } = stmt.importClause;
        if (name) link(name); // default import
        if (namedBindings) {
          if (ts.isNamedImports(namedBindings)) {
            for (const spec of namedBindings.elements) link(spec.name);
          } else {
            link(namedBindings.name); // `import * as ns` — aliases the module file
          }
        }
      } else if (
        ts.isExportDeclaration(stmt) &&
        stmt.moduleSpecifier // `export { x }` without a source is a local export, not a re-export
      ) {
        const { exportClause } = stmt;
        if (!exportClause) {
          link(stmt.moduleSpecifier); // `export * from` — no named clause; targets the module file
        } else if (ts.isNamedExports(exportClause)) {
          for (const spec of exportClause.elements) link(spec.name);
        } else {
          link(exportClause.name); // `export * as ns from` — aliases the module file
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
    if (ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
      if (node.type) annotations.push(node.type);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isGetAccessorDeclaration(node)
    ) {
      if (node.type) annotations.push(node.type); // return type
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
          let inlineCount = 0;
          for (const handler of handlers) {
            if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
              // Inline handler: synthesize a Function node (named by the route) so
              // the route can reference it AND — because we register the arrow in
              // declToId and run before collectCalls — its body's calls attribute
              // to it. A suffix disambiguates multiple inline handlers on one route.
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
              edges.push({ from: routeId, to: handlerId, kind: "References" });
              continue;
            }
            const to = resolveValueRef(handler, checker, declToId, root);
            if (to && to !== routeId) edges.push({ from: routeId, to, kind: "References" });
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
              edges.push({ from: routeId, to: handlerId, kind: "References" });
            }
          }
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
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
    return { kind: "Function", name: node.name.text };
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
  if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && ts.isIdentifier(node.name)) {
    return { kind: "Method", name: node.name.text };
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
    return { kind: "Function", name: node.name.text };
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
  return undefined;
}

/**
 * Resolve a call's callee to a graph node id, following import aliases. Accepts
 * a `new` expression too: its `.expression` is the constructed class, which
 * resolves the same way (so construction counts as a call site).
 */
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
