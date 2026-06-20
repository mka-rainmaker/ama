import * as fs from "node:fs";
import * as path from "node:path";
import type Parser from "web-tree-sitter";
import {
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  fileId,
  symbolId,
} from "../../graph/index.js";
import type { AnalysisResult, Analyzer } from "../types.js";
import { parse } from "./treesitter.js";

/** How to turn one kind of CST node into a graph symbol. */
export interface SymbolRule {
  /** Graph node kind to emit (the fallback when {@link kindByChild} matches nothing). */
  readonly kind: NodeKind;
  /** CST field holding the symbol's identifier (default "name"). */
  readonly nameField?: string;
  /**
   * Refine the kind by a child node's type — for languages where one CST node
   * covers several kinds (e.g. Go's `type_spec` is a `struct_type` → Class, an
   * `interface_type` → Interface, else a TypeAlias). First matching named child
   * wins; falls back to {@link kind}.
   */
  readonly kindByChild?: Readonly<Record<string, NodeKind>>;
}

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
          this.walk(tree.rootNode, "", id, rel, fileNodes, fileEdges);
          if (this.spec.resolveImports)
            this.collectImports(tree.rootNode, rel, root, id, fileEdges);
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

  /** Walk named CST children, emitting symbol nodes and recursing for nesting. */
  private walk(
    node: Parser.SyntaxNode,
    prefix: string,
    containerId: string,
    rel: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): void {
    for (const child of node.namedChildren) {
      const rule = this.spec.symbols[child.type];
      const name = rule ? symbolName(child, rule) : undefined;
      if (rule && name) {
        const qualifiedName = prefix ? `${prefix}.${name}` : name;
        const id = symbolId({ file: rel, qualifiedName });
        nodes.push({
          id,
          kind: kindFor(rule, child),
          name,
          file: rel,
          qualifiedName,
          tier: "baseline",
          range: { startLine: child.startPosition.row + 1, endLine: child.endPosition.row + 1 },
        });
        edges.push({ from: containerId, to: id, kind: "Defines" });
        // Descend into the symbol so members nest under it (e.g. `Class.method`).
        this.walk(child, qualifiedName, id, rel, nodes, edges);
      } else {
        // Not a symbol (or anonymous) — keep looking for symbols inside it.
        this.walk(child, prefix, containerId, rel, nodes, edges);
      }
    }
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

/** A symbol's name, by descending tiers of grammar convention:
 *  1. a `name` field (most languages);
 *  2. a `declarator` field drilled to its identifier (C/C++ — ama-s8q.9);
 *  3. the first identifier-like child (Kotlin et al. name declarations
 *     positionally, with no field — ama-0ze). */
function symbolName(node: Parser.SyntaxNode, rule: SymbolRule): string | undefined {
  const named = node.childForFieldName(rule.nameField ?? "name");
  if (named) return named.text;
  const decl = node.childForFieldName("declarator");
  if (decl) return declaratorIdentifier(decl);
  for (const child of node.namedChildren) {
    if (child.type.endsWith("identifier")) return child.text;
  }
  return undefined;
}

/** Drill a C/C++ declarator (function_declarator, pointer_declarator, …) down its
 *  `declarator` field to the identifier it ultimately names. (ama-s8q.9) */
function declaratorIdentifier(node: Parser.SyntaxNode): string | undefined {
  if (node.type.endsWith("identifier")) return node.text;
  const inner = node.childForFieldName("declarator");
  return inner ? declaratorIdentifier(inner) : undefined;
}

/** Resolve a symbol's kind, refining by a child node type when the rule asks. */
function kindFor(rule: SymbolRule, node: Parser.SyntaxNode): NodeKind {
  if (rule.kindByChild) {
    for (const child of node.namedChildren) {
      const refined = rule.kindByChild[child.type];
      if (refined) return refined;
    }
  }
  return rule.kind;
}
