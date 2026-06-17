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
  /** Graph node kind to emit. */
  readonly kind: NodeKind;
  /** CST field holding the symbol's identifier (default "name"). */
  readonly nameField?: string;
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
      const code = fs.readFileSync(path.join(root, rel), "utf8");
      const tree = await parse(this.spec.grammar, code);
      const id = fileId(rel);
      nodes.push({
        id,
        kind: "File",
        name: path.basename(rel),
        file: rel,
        qualifiedName: "",
        tier: "baseline",
        range: { startLine: 1, endLine: tree.rootNode.endPosition.row + 1 },
      });
      this.walk(tree.rootNode, "", id, rel, nodes, edges);
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
      const nameNode = rule ? child.childForFieldName(rule.nameField ?? "name") : null;
      if (rule && nameNode) {
        const name = nameNode.text;
        const qualifiedName = prefix ? `${prefix}.${name}` : name;
        const id = symbolId({ file: rel, qualifiedName });
        nodes.push({
          id,
          kind: rule.kind,
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
}
