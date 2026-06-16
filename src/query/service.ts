import * as fs from "node:fs";
import * as path from "node:path";
import type { GraphNode, NodeKind } from "../graph/index.js";
import type { InMemoryStore } from "../store/memory.js";

export interface SearchOptions {
  /** Maximum number of hits to return (default 50). */
  limit?: number;
  /** Restrict to a single node kind. */
  kind?: NodeKind;
}

export interface Snippet {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * Read-side of the graph: the four MVP questions an agent asks, answered from
 * the store. A "symbol reference" is either an exact node id (e.g.
 * "src/a.ts#Foo.bar") or a bare name ("bar"); names may resolve to several nodes.
 */
export class QueryService {
  constructor(
    private readonly store: InMemoryStore,
    /** Absolute repo root, used to read source for snippets. */
    private readonly root: string,
  ) {}

  /** Symbols whose simple name contains `query` (case-insensitive). */
  searchSymbol(query: string, opts: SearchOptions = {}): GraphNode[] {
    const needle = query.toLowerCase();
    const limit = opts.limit ?? 50;
    const hits: GraphNode[] = [];
    for (const node of this.store.allNodes()) {
      if (opts.kind && node.kind !== opts.kind) continue;
      if (node.name.toLowerCase().includes(needle)) hits.push(node);
    }
    // Exact name matches first, then alphabetical — stable, useful ordering.
    hits.sort((a, b) => {
      const ax = a.name.toLowerCase() === needle ? 0 : 1;
      const bx = b.name.toLowerCase() === needle ? 0 : 1;
      return ax - bx || a.qualifiedName.localeCompare(b.qualifiedName);
    });
    return hits.slice(0, limit);
  }

  /** Symbols that call the referenced symbol. */
  findCallers(ref: string): GraphNode[] {
    const targets = this.resolve(ref);
    const callers = new Map<string, GraphNode>();
    for (const target of targets) {
      for (const edge of this.store.edgesTo(target.id, "Calls")) {
        const caller = this.store.getNode(edge.from);
        if (caller) callers.set(caller.id, caller);
      }
    }
    return [...callers.values()];
  }

  /** Symbols the referenced symbol calls. */
  findCallees(ref: string): GraphNode[] {
    const sources = this.resolve(ref);
    const callees = new Map<string, GraphNode>();
    for (const source of sources) {
      for (const edge of this.store.edgesFrom(source.id, "Calls")) {
        const callee = this.store.getNode(edge.to);
        if (callee) callees.set(callee.id, callee);
      }
    }
    return [...callees.values()];
  }

  /** Verbatim source for a symbol, or undefined if it has no known location. */
  getCodeSnippet(ref: string): Snippet | undefined {
    const node = this.resolve(ref).find((n) => n.range);
    if (!node || !node.range) return undefined;
    const source = fs.readFileSync(path.resolve(this.root, node.file), "utf8");
    const lines = source.split("\n");
    const text = lines.slice(node.range.startLine - 1, node.range.endLine).join("\n");
    return {
      id: node.id,
      file: node.file,
      startLine: node.range.startLine,
      endLine: node.range.endLine,
      text,
    };
  }

  /**
   * Resolve a reference to node(s), most-specific first: exact id, then simple
   * name (e.g. "compute"), then dotted qualified name (e.g. "Service.compute").
   */
  private resolve(ref: string): GraphNode[] {
    const byId = this.store.getNode(ref);
    if (byId) return [byId];
    const byName = this.store.nodesByName(ref);
    if (byName.length) return byName;
    return [...this.store.allNodes()].filter((n) => n.qualifiedName === ref);
  }
}
