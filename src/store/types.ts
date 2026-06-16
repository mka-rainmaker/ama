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

  readonly nodeCount: number;
  readonly edgeCount: number;

  /** Record (or replace) a file's fingerprint. */
  recordFile(meta: FileMeta): void;
  getFile(path: string): FileMeta | undefined;
  allFiles(): FileMeta[];

  /** Persist (or replace) an arbitrary string value, e.g. coverage metadata. */
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | undefined;
}
