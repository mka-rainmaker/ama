import type { EdgeKind, GraphEdge, GraphNode } from "../graph/index.js";
import type { FileMeta, Store } from "./types.js";

/**
 * In-memory graph store for the MVP. Keeps the canonical node map plus three
 * derived indexes (by-name, outgoing, incoming) so the query service answers
 * search / callers / callees without scanning the whole graph.
 *
 * Adjacency is kept as plain arrays keyed by node id; kind filtering is a linear
 * scan of a single node's edges, which is cheap because real fan-out is small.
 */
export class InMemoryStore implements Store {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges: GraphEdge[] = [];
  private readonly byName = new Map<string, GraphNode[]>();
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly incoming = new Map<string, GraphEdge[]>();
  /** `from\0to\0kind` keys of edges already stored, so identical edges collapse. */
  private readonly edgeKeys = new Set<string>();
  private readonly files = new Map<string, FileMeta>();
  private readonly meta = new Map<string, string>();

  addNode(node: GraphNode): void {
    // Idempotent upsert: re-adding an existing id (a re-indexed file) replaces
    // the node without leaving a stale by-name entry behind.
    const prev = this.nodes.get(node.id);
    if (prev) this.unindexName(prev);
    this.nodes.set(node.id, node);
    const sameName = this.byName.get(node.name);
    if (sameName) sameName.push(node);
    else this.byName.set(node.name, [node]);
  }

  addEdge(edge: GraphEdge): void {
    // An edge is identified by (from, to, kind); the same fact emitted twice
    // (e.g. a direct and an aliased call to one target) collapses to one edge.
    const key = edgeKey(edge);
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push(edge);
    push(this.outgoing, edge.from, edge);
    push(this.incoming, edge.to, edge);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Nodes whose simple (unqualified) name matches exactly. */
  nodesByName(name: string): GraphNode[] {
    return this.byName.get(name) ?? [];
  }

  searchByName(query: string, limit = 50): GraphNode[] {
    const needle = query.toLowerCase();
    if (!needle) return [];
    const hits: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      // Match the simple name or the qualified name, so a dotted ref
      // ("Cls.method") and a container name both resolve.
      if (
        node.name.toLowerCase().includes(needle) ||
        node.qualifiedName.toLowerCase().includes(needle)
      ) {
        hits.push(node);
      }
    }
    // Exact matches (on either name) first, then alphabetical by qualified name.
    hits.sort((a, b) => {
      const ax =
        a.name.toLowerCase() === needle || a.qualifiedName.toLowerCase() === needle ? 0 : 1;
      const bx =
        b.name.toLowerCase() === needle || b.qualifiedName.toLowerCase() === needle ? 0 : 1;
      return ax - bx || a.qualifiedName.localeCompare(b.qualifiedName);
    });
    return hits.slice(0, limit);
  }

  /** Edges leaving `id`, optionally filtered by kind. */
  edgesFrom(id: string, kind?: EdgeKind): GraphEdge[] {
    const out = this.outgoing.get(id) ?? [];
    return kind ? out.filter((e) => e.kind === kind) : out.slice();
  }

  /** Edges arriving at `id`, optionally filtered by kind. */
  edgesTo(id: string, kind?: EdgeKind): GraphEdge[] {
    const into = this.incoming.get(id) ?? [];
    return kind ? into.filter((e) => e.kind === kind) : into.slice();
  }

  /** Every node in insertion order — for stats and full scans. */
  allNodes(): IterableIterator<GraphNode> {
    return this.nodes.values();
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.length;
  }

  recordFile(meta: FileMeta): void {
    this.files.set(meta.path, meta);
  }

  getFile(path: string): FileMeta | undefined {
    return this.files.get(path);
  }

  allFiles(): FileMeta[] {
    return [...this.files.values()];
  }

  removeFile(path: string): void {
    const owned = new Set<string>();
    for (const [id, n] of this.nodes) {
      if (n.file === path) owned.add(id);
    }
    for (const id of owned) {
      const n = this.nodes.get(id);
      this.nodes.delete(id);
      if (n) this.unindexName(n);
    }
    // An edge a file owns leaves one of its nodes; keep every other edge.
    this.resetEdges(this.edges.filter((e) => !owned.has(e.from)));
    this.files.delete(path);
  }

  reconcileFile(path: string, nodes: GraphNode[], edges: GraphEdge[]): void {
    const newIds = new Set(nodes.map((n) => n.id));
    const oldIds = new Set<string>();
    for (const n of this.nodes.values()) {
      if (n.file === path) oldIds.add(n.id);
    }
    // 1. Drop symbols that disappeared from the file (their edges go in step 3).
    for (const id of oldIds) {
      if (newIds.has(id)) continue;
      const n = this.nodes.get(id);
      this.nodes.delete(id);
      if (n) this.unindexName(n);
    }
    // 2. Upsert the file's current nodes (addNode is idempotent).
    for (const n of nodes) this.addNode(n);
    // 3. Reconcile the edges the file owns (those leaving any node it held
    //    before or after) to exactly `edges`: drop the no-longer-emitted ones,
    //    then add the rest — addEdge dedupes, so unchanged edges are no-ops.
    const owners = new Set([...oldIds, ...newIds]);
    const fresh = new Set(edges.map(edgeKey));
    const stale = new Set(this.edges.filter((e) => owners.has(e.from) && !fresh.has(edgeKey(e))));
    if (stale.size) this.resetEdges(this.edges.filter((e) => !stale.has(e)));
    for (const e of edges) this.addEdge(e);
  }

  /** Drop a node from the by-name index. */
  private unindexName(node: GraphNode): void {
    const remaining = this.byName.get(node.name)?.filter((x) => x.id !== node.id);
    if (remaining?.length) this.byName.set(node.name, remaining);
    else this.byName.delete(node.name);
  }

  /** Replace the edge list and rebuild the adjacency indexes from it. */
  private resetEdges(kept: GraphEdge[]): void {
    this.edges.length = 0;
    this.outgoing.clear();
    this.incoming.clear();
    this.edgeKeys.clear();
    for (const e of kept) {
      this.edges.push(e);
      push(this.outgoing, e.from, e);
      push(this.incoming, e.to, e);
      this.edgeKeys.add(edgeKey(e));
    }
  }

  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }

  getMeta(key: string): string | undefined {
    return this.meta.get(key);
  }

  clear(): void {
    this.nodes.clear();
    this.edges.length = 0;
    this.byName.clear();
    this.outgoing.clear();
    this.incoming.clear();
    this.edgeKeys.clear();
    this.files.clear();
    this.meta.clear();
  }

  close(): void {
    // Nothing to release for the in-memory store.
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Canonical identity of an edge: its (from, to, kind) triple, as printable JSON
 * (never a NUL-delimited string — that would mark the source file binary). */
function edgeKey(e: GraphEdge): string {
  return JSON.stringify([e.from, e.to, e.kind]);
}
