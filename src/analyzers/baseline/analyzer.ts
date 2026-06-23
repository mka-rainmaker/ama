import * as fs from "node:fs";
import * as path from "node:path";
import type Parser from "web-tree-sitter";
import { type GraphEdge, type GraphNode, fileId } from "../../graph/index.js";
import type { AnalysisResult, Analyzer } from "../types.js";
import { parse } from "./treesitter.js";
import { type SymbolRule, walkSymbols } from "./walk.js";

export type { SymbolRule };

/**
 * Describes a language for the {@link BaselineAnalyzer}: which extensions it
 * owns, which bundled tree-sitter grammar to parse with, and which CST node
 * types are symbols. Deep semantics (calls, types) are out of scope — baseline
 * is syntactic breadth: files and the symbols they define.
 */
export interface LanguageSpec {
  readonly language: string;
  readonly extensions: readonly string[];
  /** Key into the bundled grammar registry (see {@link parse}). */
  readonly grammar: string;
  /** CST node type → how to emit a symbol for it. */
  readonly symbols: Readonly<Record<string, SymbolRule>>;
  /**
   * Optional import resolver: given an import CST node, the importing file's
   * repo-relative path, and the index root, return each imported module as an
   * ordered list of candidate repo-relative file paths — the analyzer emits a
   * File→File `Imports` edge to the first candidate that exists on disk. Returns
   * `undefined` for a non-import node, `[]` for an unresolvable (stdlib/third-party)
   * import. `root` lets a config-aware language (Go's `go.mod`) resolve a
   * module-qualified path; path-based languages can ignore it. (ama-8nr, ama-9yu)
   */
  readonly resolveImports?: (
    node: Parser.SyntaxNode,
    importerRel: string,
    root: string,
  ) => string[][] | undefined;

  /**
   * Optional route detector: walk the CST for framework route registrations and return Route
   * nodes plus their handler `References` edges. Baseline tier — a heuristic, syntactic match
   * on decorator/call patterns (e.g. Python's `@app.get("/x")`). (ama-bvg)
   */
  readonly collectRoutes?: (
    root: Parser.SyntaxNode,
    rel: string,
  ) => { nodes: GraphNode[]; edges: GraphEdge[] };

  /**
   * Optional call detector: walk the CST for call sites and return heuristic `Calls` edges.
   * Baseline tier — name-based resolution within the file (no types), so callers/callees and
   * blast-radius work for languages without a deep analyzer. (ama-bnj)
   */
  readonly collectCalls?: (
    root: Parser.SyntaxNode,
    rel: string,
  ) => { nodes: GraphNode[]; edges: GraphEdge[] };

  /**
   * Optional type-hierarchy detector: walk the CST for `extends`/`implements` clauses and return
   * `Inherits`/`Implements` edges whose target is a within-file type id or a `type:<SimpleName>`
   * candidate {@link deriveTypeEdges} resolves whole-graph. Baseline tier — syntactic, name-based,
   * with no `@Override`/signature reasoning (dispatch derives those). (ama 0.4.0 S1)
   */
  readonly collectHierarchy?: (
    root: Parser.SyntaxNode,
    rel: string,
  ) => { nodes: GraphNode[]; edges: GraphEdge[] };
}

/**
 * A language-agnostic, syntactic (tier `baseline`) analyzer driven by a
 * {@link LanguageSpec}. It parses each file with tree-sitter and walks the CST,
 * emitting a File node plus a node for every symbol the spec recognizes, with a
 * `Defines` edge from the enclosing symbol (or the file) and a dotted
 * qualified name for nested symbols. One instance handles one language.
 */
export class BaselineAnalyzer implements Analyzer {
  readonly tier = "baseline";
  readonly language: string;
  readonly extensions: readonly string[];

  constructor(private readonly spec: LanguageSpec) {
    this.language = spec.language;
    this.extensions = spec.extensions;
  }

  async analyze(root: string, files: string[]): Promise<AnalysisResult> {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const rel of files) {
      // Per-file isolation: a single unreadable or unparseable file must not lose
      // the whole language's batch — finer than the indexer's per-analyzer catch
      // (ama-m8k.9). Build into local arrays and merge only on success, so a
      // mid-walk throw leaves no partial nodes behind. (ama-eww)
      try {
        const code = fs.readFileSync(path.join(root, rel), "utf8");
        const tree = await parse(this.spec.grammar, code);
        // A web-tree-sitter Tree holds WASM memory; free it once walked so a large
        // index doesn't accumulate one tree per file. `finally` covers a throw in
        // walk. The extracted GraphNodes are plain copies, valid after delete. (ama-5o1)
        try {
          const id = fileId(rel);
          const fileNodes: GraphNode[] = [
            {
              id,
              kind: "File",
              name: path.basename(rel),
              file: rel,
              qualifiedName: "",
              tier: "baseline",
              range: { startLine: 1, endLine: tree.rootNode.endPosition.row + 1 },
            },
          ];
          const fileEdges: GraphEdge[] = [];
          walkSymbols(tree.rootNode, this.spec.symbols, rel, id, "", fileNodes, fileEdges);
          if (this.spec.resolveImports)
            this.collectImports(tree.rootNode, rel, root, id, fileEdges);
          if (this.spec.collectRoutes) {
            const routes = this.spec.collectRoutes(tree.rootNode, rel);
            fileNodes.push(...routes.nodes);
            fileEdges.push(...routes.edges);
          }
          if (this.spec.collectCalls) {
            const calls = this.spec.collectCalls(tree.rootNode, rel);
            fileNodes.push(...calls.nodes);
            fileEdges.push(...calls.edges);
          }
          if (this.spec.collectHierarchy) {
            const hierarchy = this.spec.collectHierarchy(tree.rootNode, rel);
            fileNodes.push(...hierarchy.nodes);
            fileEdges.push(...hierarchy.edges);
          }
          nodes.push(...fileNodes);
          edges.push(...fileEdges);
        } finally {
          tree.delete();
        }
      } catch (err) {
        console.error(
          `[ama] ${this.spec.language} analyzer failed on ${rel}; skipping it. ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { nodes, edges };
  }

  /** Walk the CST for import statements and emit a File→File `Imports` edge to
   *  each imported module that resolves (by path) to a file on disk. (ama-8nr) */
  private collectImports(
    node: Parser.SyntaxNode,
    importerRel: string,
    root: string,
    fileNodeId: string,
    edges: GraphEdge[],
  ): void {
    const groups = this.spec.resolveImports?.(node, importerRel, root);
    if (groups) {
      for (const candidates of groups) {
        const target = candidates.find((c) => fs.existsSync(path.join(root, c)));
        if (target) edges.push({ from: fileNodeId, to: fileId(target), kind: "Imports" });
      }
    }
    for (const child of node.namedChildren) {
      this.collectImports(child, importerRel, root, fileNodeId, edges);
    }
  }
}
