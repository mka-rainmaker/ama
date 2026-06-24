import type { EdgeKind, GraphEdge, GraphNode } from "../graph/types.js";
import type { Store } from "../store/types.js";

/**
 * A portable symbol-and-occurrence index for exporting AMA's graph in a documented, interchangeable
 * JSON shape (no protobuf, no dependencies). Every symbol gets a stable id; every reference (call,
 * import, implements, …) is recorded as an occurrence at a location, alongside its definition. Tools
 * external to AMA can consume this to navigate the codebase independently — the standard
 * symbol/occurrence model for language-agnostic code intelligence.
 */

/** A usage of a symbol: definition at its declaration, or reference via an edge. */
export interface CodeIntelOccurrence {
  /** The symbol id being referenced (stable, location-independent). */
  symbol: string;
  /** What kind of reference: definition (the symbol's declaration) or reference
   * (an edge pointing to it). */
  role: "definition" | "reference";
  /** Source range when available (non-synthetic nodes and edge targets in the
   * from-node's file). Absent for synthetic symbols or edges with no location. */
  range?: {
    startLine: number;
    endLine: number;
  };
}

/** All symbols defined in one file plus all their occurrences. */
export interface CodeIntelDocument {
  /** Repo-relative file path. */
  path: string;
  /** Symbols defined in this file: their id, kind, simple name, and optional range. */
  symbols: Array<{
    symbol: string;
    kind: string;
    name: string;
    range?: {
      startLine: number;
      endLine: number;
    };
  }>;
  /** All occurrences in this file: definition of each symbol plus references
   * from edges rooted in this file. */
  occurrences: CodeIntelOccurrence[];
}

/** The complete portable index. */
export interface CodeIntelIndex {
  /** Schema version. */
  version: string;
  /** Repository root. */
  root: string;
  /** Every indexed file and its symbols/occurrences. */
  documents: CodeIntelDocument[];
}

/**
 * Edge kinds that represent a semantic reference: the from-node refers to or
 * uses the to-node. Edges like Defines are internal structure, not references.
 */
const REFERENCE_EDGE_KINDS: Set<EdgeKind> = new Set([
  "Calls",
  "Instantiates",
  "Imports",
  "ImportsType",
  "References",
  "Implements",
  "Inherits",
  "UsesType",
  "Returns",
  "Overrides",
]);

/**
 * Export the store as a portable, language-agnostic code-intelligence index.
 * Groups non-File nodes by file into documents; each node contributes a symbol
 * definition, and each reference edge contributes an occurrence.
 *
 * @param store The graph store.
 * @param root The repository root path.
 * @returns A CodeIntelIndex ready for serialization or external consumption.
 */
export function exportCodeIntel(store: Store, root: string): CodeIntelIndex {
  const documentsByPath = new Map<string, CodeIntelDocument>();

  // Phase 1: Add all nodes as symbols and definition occurrences.
  for (const node of store.allNodes()) {
    // Skip File nodes; they're structure, not symbols to index.
    if (node.kind === "File") continue;

    // Create or fetch the document for this node's file.
    let doc = documentsByPath.get(node.file);
    if (!doc) {
      doc = {
        path: node.file,
        symbols: [],
        occurrences: [],
      };
      documentsByPath.set(node.file, doc);
    }

    // Add the symbol.
    doc.symbols.push({
      symbol: node.id,
      kind: node.kind,
      name: node.name,
      range: node.range,
    });

    // Add a definition occurrence at this symbol's location.
    doc.occurrences.push({
      symbol: node.id,
      role: "definition",
      range: node.range,
    });
  }

  // Phase 2: Add reference occurrences from edges.
  for (const edge of store.allEdges()) {
    // Only reference edge kinds generate occurrences.
    if (!REFERENCE_EDGE_KINDS.has(edge.kind)) continue;

    // Look up the from-node to find its file.
    const fromNode = store.getNode(edge.from);
    if (!fromNode) continue;

    // Reference lives in the from-node's file.
    let doc = documentsByPath.get(fromNode.file);
    if (!doc) {
      doc = {
        path: fromNode.file,
        symbols: [],
        occurrences: [],
      };
      documentsByPath.set(fromNode.file, doc);
    }

    // Add a reference occurrence pointing at the to-node.
    doc.occurrences.push({
      symbol: edge.to,
      role: "reference",
      // Range is not part of edges in AMA (edges have at/sites for call sites,
      // not source ranges for the reference itself), so we omit it here.
    });
  }

  // Phase 3: Sort documents by path for stable output.
  const documents = Array.from(documentsByPath.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  return {
    version: "0.1",
    root,
    documents,
  };
}
