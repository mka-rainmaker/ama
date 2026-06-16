import * as path from "node:path";
import ts from "typescript";
import { fileId, symbolId } from "../../graph/index.js";
import type { GraphEdge, GraphNode, NodeKind, SourceRange } from "../../graph/index.js";
import type { AnalysisResult, Analyzer } from "../types.js";

/**
 * Deep TypeScript analyzer built on the TypeScript Compiler API.
 *
 * Two passes over each source file:
 *  1. Structural — emit nodes (File, Function, Class, Interface, Enum, Method)
 *     and `Defines` edges, recording each declaration's AST node so later
 *     references can be linked back to graph ids.
 *  2. Resolution — through the type checker, emit `Calls` edges (enclosing
 *     function/method → callee), `Inherits`/`Implements` edges (class → base
 *     class / interface), and `Imports` edges (file → each symbol it imports or
 *     re-exports). References to symbols outside the analyzed set (library code)
 *     resolve to no node and are skipped, so the graph only asserts edges it can
 *     actually back.
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
        this.collectCalls(sf, undefined, declToId, checker, edges);
        this.collectHeritage(sf, declToId, checker, edges);
        this.collectImports(sf, fileId(rel), declToId, checker, edges);
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
  ): void {
    node.forEachChild((child) => {
      if (ts.isCallExpression(child) && enclosingId) {
        const callee = resolveCallee(child, checker, declToId);
        if (callee) edges.push({ from: enclosingId, to: callee, kind: "Calls" });
      }
      const childId = declToId.get(child);
      const nextEnclosing =
        childId && (ts.isFunctionDeclaration(child) || ts.isMethodDeclaration(child))
          ? childId
          : enclosingId;
      this.collectCalls(child, nextEnclosing, declToId, checker, edges);
    });
  }

  /** Walk a subtree emitting an `Implements` edge for each `class … implements I`. */
  private collectHeritage(
    node: ts.Node,
    declToId: Map<ts.Node, string>,
    checker: ts.TypeChecker,
    edges: GraphEdge[],
  ): void {
    if (ts.isClassDeclaration(node)) {
      const from = declToId.get(node);
      for (const clause of node.heritageClauses ?? []) {
        // On a class, `extends` is inheritance; `implements` is interface conformance.
        const kind = clause.token === ts.SyntaxKind.ExtendsKeyword ? "Inherits" : "Implements";
        for (const type of clause.types) {
          const to = from && resolveHeritage(type.expression, checker, declToId);
          if (from && to) edges.push({ from, to, kind });
        }
      }
    }
    node.forEachChild((child) => this.collectHeritage(child, declToId, checker, edges));
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
  ): void {
    const link = (name: ts.Node): void => {
      const to = resolveImport(name, checker, declToId);
      if (to) edges.push({ from: fromId, to, kind: "Imports" });
    };
    // Imports can only appear as top-level statements in an ES module.
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && stmt.importClause) {
        const { name, namedBindings } = stmt.importClause;
        if (name) link(name); // default import
        if (namedBindings && ts.isNamedImports(namedBindings)) {
          for (const spec of namedBindings.elements) link(spec.name);
        }
      } else if (
        ts.isExportDeclaration(stmt) &&
        stmt.moduleSpecifier && // `export { x }` without a source is a local export, not a re-export
        stmt.exportClause &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        for (const spec of stmt.exportClause.elements) link(spec.name);
      }
    }
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
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    return { kind: "Method", name: node.name.text };
  }
  return undefined;
}

/** Resolve a call's callee to a graph node id, following import aliases. */
function resolveCallee(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
): string | undefined {
  let symbol = checker.getSymbolAtLocation(call.expression);
  if (!symbol) {
    const decl = checker.getResolvedSignature(call)?.declaration;
    return decl ? declToId.get(decl) : undefined;
  }
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return decl ? declToId.get(decl) : undefined;
}

/** Resolve a heritage type reference (e.g. the `I` in `implements I`) to a node id. */
function resolveHeritage(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
): string | undefined {
  let symbol = checker.getSymbolAtLocation(expr);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  // Interfaces are type-only, so they have no valueDeclaration — use declarations.
  const decl = symbol.declarations?.[0];
  return decl ? declToId.get(decl) : undefined;
}

/** Resolve an imported or re-exported name to its original declaration's node id. */
function resolveImport(
  name: ts.Node,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
): string | undefined {
  let symbol = checker.getSymbolAtLocation(name);
  if (!symbol) return undefined;
  // Import/re-export bindings are aliases; follow the chain to the real declaration.
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return decl ? declToId.get(decl) : undefined;
}

function rangeOf(node: ts.Node, sf: ts.SourceFile): SourceRange {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return { startLine: start.line + 1, endLine: end.line + 1 };
}
