import type Parser from "web-tree-sitter";
import { type GraphEdge, type GraphNode, type NodeKind, symbolId } from "../../graph/index.js";

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
 * Walk named CST children, emitting a symbol node for each that matches a
 * {@link SymbolRule} (with a `Defines` edge from its container and a dotted
 * qualified name for nesting), and recursing. Shared by the {@link BaselineAnalyzer}
 * and the SFC analyzer; `lineOffset` is added to every emitted line so a fragment
 * parsed out of a larger file (an SFC `<script>` block) maps back to file lines.
 * (ama-q1u)
 */
export function walkSymbols(
  node: Parser.SyntaxNode,
  symbols: Readonly<Record<string, SymbolRule>>,
  rel: string,
  containerId: string,
  prefix: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  lineOffset = 0,
): void {
  for (const child of node.namedChildren) {
    const rule = symbols[child.type];
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
        range: {
          startLine: child.startPosition.row + 1 + lineOffset,
          endLine: child.endPosition.row + 1 + lineOffset,
        },
      });
      edges.push({ from: containerId, to: id, kind: "Defines" });
      // Descend into the symbol so members nest under it (e.g. `Class.method`).
      walkSymbols(child, symbols, rel, id, qualifiedName, nodes, edges, lineOffset);
    } else {
      // Not a symbol (or anonymous) — keep looking for symbols inside it.
      walkSymbols(child, symbols, rel, containerId, prefix, nodes, edges, lineOffset);
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
