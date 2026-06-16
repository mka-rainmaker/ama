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
    for (const [abs, rel] of relByAbs) {
      const sf = program.getSourceFile(abs);
      if (sf) {
        this.collectCalls(sf, undefined, declToId, checker, edges, root);
        this.collectHeritage(sf, declToId, checker, edges, root);
        this.collectTypeUsages(sf, undefined, declToId, checker, edges, root);
        this.collectImports(sf, fileId(rel), declToId, checker, edges, root);
      }
    }

    return { nodes, edges };
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
      range: rangeOf(sf, sf),
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
    if (!decl) return;

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
      // A `new Foo()` is a construction call site, resolved the same way as a
      // plain call (to Foo's class node), so `find_callers` sees constructions.
      if ((ts.isCallExpression(child) || ts.isNewExpression(child)) && enclosingId) {
        const callee = resolveCallee(child, checker, declToId, root);
        if (callee) edges.push({ from: enclosingId, to: callee, kind: "Calls" });
      }
      const childId = declToId.get(child);
      const nextEnclosing =
        childId && (ts.isFunctionDeclaration(child) || ts.isMethodDeclaration(child))
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
   * Emit a `UsesType` edge for each named type referenced in a parameter type,
   * a function/method return type, or a property type, attributed to the nearest
   * enclosing emitted symbol — the function or method for its params and return,
   * and (until properties become nodes) the class or interface for its members'
   * types. Composite annotations are walked, so `Widget[]` or `Map<K, Widget>`
   * still link to `Widget`. Types outside the analyzed set (`number`, library
   * types) resolve to no node and are skipped.
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
      ts.isMethodSignature(node)
    ) {
      if (node.type) annotations.push(node.type); // return type
    }
    if (enclosingId) {
      for (const annotation of annotations) {
        for (const ref of typeReferencesIn(annotation)) {
          const to = resolveTypeRef(ref.typeName, checker, declToId, root);
          // A type used inside its own declaration's signature is noise, not a usage.
          if (to && to !== enclosingId) edges.push({ from: enclosingId, to, kind: "UsesType" });
        }
      }
    }
    node.forEachChild((child) => {
      const childId = declToId.get(child);
      this.collectTypeUsages(child, childId ?? enclosingId, declToId, checker, edges, root);
    });
  }
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
    ts.isVariableDeclaration(node) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
    ts.isIdentifier(node.name)
  ) {
    return { kind: "Function", name: node.name.text };
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
