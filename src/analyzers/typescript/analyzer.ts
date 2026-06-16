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
 *     and `Defines` edges, recording each declaration's AST node so calls can
 *     be linked back to graph ids.
 *  2. Calls — resolve every call expression through the type checker and emit a
 *     `Calls` edge from the enclosing function/method to the callee. Calls to
 *     symbols outside the analyzed set (library code) resolve to no node and are
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
    for (const [abs] of relByAbs) {
      const sf = program.getSourceFile(abs);
      if (sf) this.collectCalls(sf, undefined, declToId, checker, edges);
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

function rangeOf(node: ts.Node, sf: ts.SourceFile): SourceRange {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return { startLine: start.line + 1, endLine: end.line + 1 };
}
