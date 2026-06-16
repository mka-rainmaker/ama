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
    this.nodes.set(node.id, node);
    const sameName = this.byName.get(node.name);
    if (sameName) sameName.push(node);
    else this.byName.set(node.name, [node]);
  }

  addEdge(edge: GraphEdge): void {
    // An edge is identified by (from, to, kind); the same fact emitted twice
    // (e.g. a direct and an aliased call to one target) collapses to one edge.
    const key = JSON.stringify([edge.from, edge.to, edge.kind]);
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
      if (node.name.toLowerCase().includes(needle)) hits.push(node);
    }
    // Exact matches first, then alphabetical by qualified name.
    hits.sort((a, b) => {
      const ax = a.name.toLowerCase() === needle ? 0 : 1;
      const bx = b.name.toLowerCase() === needle ? 0 : 1;
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

  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }

  getMeta(key: string): string | undefined {
    return this.meta.get(key);
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
