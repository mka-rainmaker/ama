import type { EdgeKind, GraphEdge, GraphNode } from "../graph/index.js";

/** Per-file fingerprint used to detect staleness for incremental re-indexing. */
export interface FileMeta {
  /** Repo-relative path. */
  path: string;
  size: number;
  mtimeMs: number;
  /** Content hash — the exact-change signal when size/mtime are inconclusive. */
  hash: string;
}

/**
 * Storage contract shared by every backend (in-memory today, SQLite next).
 * The query and indexer layers depend only on this interface, so swapping the
 * backing store never touches them.
 */
export interface Store {
  addNode(node: GraphNode): void;
  addEdge(edge: GraphEdge): void;

  getNode(id: string): GraphNode | undefined;
  /** Nodes whose simple (unqualified) name matches exactly. */
  nodesByName(name: string): GraphNode[];
  /**
   * Symbols whose name matches `query` by prefix (case-insensitive). Backends
   * may match more loosely (the in-memory store does substring), but every
   * backend must at least return names the query is a prefix of.
   */
  searchByName(query: string, limit?: number): GraphNode[];

  /** Edges leaving `id`, optionally filtered by kind. */
  edgesFrom(id: string, kind?: EdgeKind): GraphEdge[];
  /** Edges arriving at `id`, optionally filtered by kind. */
  edgesTo(id: string, kind?: EdgeKind): GraphEdge[];

  /** Every node — for stats and full scans. */
  allNodes(): IterableIterator<GraphNode>;
  /** Every edge — for whole-graph derivations (e.g. dispatch re-derivation). */
  allEdges(): GraphEdge[];

  /**
   * Replace every edge with the given provenance by `edges` (drop the old, add the
   * new). Used to re-derive a whole-graph edge class — dispatch fan-out / Overrides
   * (provenance "dispatch") — after an incremental reindex, which a single-file
   * analyze can't reproduce on its own. (ama-tr1)
   */
  replaceEdgesByProvenance(provenance: GraphEdge["provenance"], edges: GraphEdge[]): void;

  readonly nodeCount: number;
  readonly edgeCount: number;

  /** Record (or replace) a file's fingerprint. */
  recordFile(meta: FileMeta): void;
  getFile(path: string): FileMeta | undefined;
  allFiles(): FileMeta[];

  /**
   * Remove everything a file owns: its fingerprint, its nodes, and the edges
   * that originate from those nodes. Edges owned by *other* files are left
   * untouched — so an inbound edge may briefly dangle into a removed node until
   * that other file is itself re-indexed. The reconcile primitive behind
   * single-file re-indexing.
   */
  removeFile(path: string): void;

  /**
   * Apply a file's freshly-analyzed nodes and edges as a *minimal delta*: upsert
   * its nodes, drop only the symbols that disappeared, and reconcile the edges
   * it owns (those leaving its nodes) to exactly `edges`. Unchanged data and
   * everything owned by other files is left in place, so an edit churns only
   * what actually changed. Handles both creating and editing a file;
   * {@link removeFile} handles deletion.
   */
  reconcileFile(path: string, nodes: GraphNode[], edges: GraphEdge[]): void;

  /** Persist (or replace) an arbitrary string value, e.g. coverage metadata. */
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | undefined;

  /** Drop everything — nodes, edges, files, and metadata — for a clean rebuild
   * of a store that may already hold a previous index (a persistent backend). */
  clear(): void;

  /** Release any underlying resources (a SQLite connection). A no-op for the
   * in-memory store; call before discarding a store you replaced. */
  close(): void;
}
