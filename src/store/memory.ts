import type { EdgeKind, GraphEdge, GraphNode } from "../graph/index.js";

/**
 * In-memory graph store for the MVP. Keeps the canonical node map plus three
 * derived indexes (by-name, outgoing, incoming) so the query service answers
 * search / callers / callees without scanning the whole graph.
 *
 * Adjacency is kept as plain arrays keyed by node id; kind filtering is a linear
 * scan of a single node's edges, which is cheap because real fan-out is small.
 */
export class InMemoryStore {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges: GraphEdge[] = [];
  private readonly byName = new Map<string, GraphNode[]>();
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly incoming = new Map<string, GraphEdge[]>();

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    const sameName = this.byName.get(node.name);
    if (sameName) sameName.push(node);
    else this.byName.set(node.name, [node]);
  }

  addEdge(edge: GraphEdge): void {
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
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
