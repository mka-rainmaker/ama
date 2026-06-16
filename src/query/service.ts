import * as fs from "node:fs";
import * as path from "node:path";
import type { GraphNode, NodeKind } from "../graph/index.js";
import type { Store } from "../store/types.js";

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

/** Everything about one node in a single answer — the higher-order `node` query. */
export interface NodeView {
  /** The resolved node itself (most-specific match for the ref). */
  node: GraphNode;
  /** Verbatim source, when the node has a known location. */
  snippet?: Snippet;
  /** Symbols that call it. */
  callers: GraphNode[];
  /** Symbols it calls. */
  callees: GraphNode[];
  /** Files that import (or re-export) it. */
  dependents: GraphNode[];
}

/** A census of the graph's node and edge kinds — what the index actually contains. */
export interface GraphSchema {
  /** Count of nodes per kind (e.g. Class, Function, Method, Interface, File). */
  nodes: Record<string, number>;
  /** Count of edges per kind (e.g. Defines, Calls, Imports, Implements, UsesType). */
  edges: Record<string, number>;
}

/**
 * Read-side of the graph: the four MVP questions an agent asks, answered from
 * the store. A "symbol reference" is either an exact node id (e.g.
 * "src/a.ts#Foo.bar") or a bare name ("bar"); names may resolve to several nodes.
 */
export class QueryService {
  constructor(
    private readonly store: Store,
    /** Absolute repo root, used to read source for snippets. */
    private readonly root: string,
  ) {}

  /**
   * Symbols whose name matches `query`, answered by the store's name index
   * (substring in-memory, FTS5 prefix in SQLite). Kind is filtered on top.
   */
  searchSymbol(query: string, opts: SearchOptions = {}): GraphNode[] {
    const hits = this.store.searchByName(query, opts.limit ?? 50);
    return opts.kind ? hits.filter((n) => n.kind === opts.kind) : hits;
  }

  /**
   * Full-text search over symbol *bodies* (not names): symbols whose verbatim
   * source contains `query`, case-insensitively. Each file is read once and
   * sliced per symbol; File nodes are excluded so a hit points at the containing
   * symbol. This is the in-memory tier — a plain substring scan, not an FTS
   * index (the SQLite store can specialize it later).
   */
  searchCode(query: string, opts: { limit?: number } = {}): GraphNode[] {
    const needle = query.toLowerCase();
    const limit = opts.limit ?? 50;
    const byFile = new Map<string, GraphNode[]>();
    for (const node of this.store.allNodes()) {
      if (!node.range || node.kind === "File") continue;
      const group = byFile.get(node.file) ?? [];
      group.push(node);
      byFile.set(node.file, group);
    }
    const matches: GraphNode[] = [];
    for (const [file, nodes] of byFile) {
      let lines: string[];
      try {
        lines = fs.readFileSync(path.resolve(this.root, file), "utf8").split("\n");
      } catch {
        continue; // a file that vanished since indexing — skip it
      }
      for (const node of nodes) {
        if (!node.range) continue;
        const body = lines.slice(node.range.startLine - 1, node.range.endLine).join("\n");
        if (body.toLowerCase().includes(needle)) {
          matches.push(node);
          if (matches.length >= limit) return matches;
        }
      }
    }
    return matches;
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

  /** Classes that implement the referenced interface. */
  findImplementations(ref: string): GraphNode[] {
    const targets = this.resolve(ref);
    const implementers = new Map<string, GraphNode>();
    for (const target of targets) {
      for (const edge of this.store.edgesTo(target.id, "Implements")) {
        const cls = this.store.getNode(edge.from);
        if (cls) implementers.set(cls.id, cls);
      }
    }
    return [...implementers.values()];
  }

  /** Interfaces the referenced class implements. */
  findInterfaces(ref: string): GraphNode[] {
    const sources = this.resolve(ref);
    const interfaces = new Map<string, GraphNode>();
    for (const source of sources) {
      for (const edge of this.store.edgesFrom(source.id, "Implements")) {
        const iface = this.store.getNode(edge.to);
        if (iface) interfaces.set(iface.id, iface);
      }
    }
    return [...interfaces.values()];
  }

  /** Files that import (or re-export) the referenced symbol. */
  findImporters(ref: string): GraphNode[] {
    const targets = this.resolve(ref);
    const importers = new Map<string, GraphNode>();
    for (const target of targets) {
      for (const edge of this.store.edgesTo(target.id, "Imports")) {
        const file = this.store.getNode(edge.from);
        if (file) importers.set(file.id, file);
      }
    }
    return [...importers.values()];
  }

  /** Symbols the referenced file imports (or re-exports). */
  findImports(ref: string): GraphNode[] {
    const sources = this.resolve(ref);
    const imports = new Map<string, GraphNode>();
    for (const source of sources) {
      for (const edge of this.store.edgesFrom(source.id, "Imports")) {
        const imported = this.store.getNode(edge.to);
        if (imported) imports.set(imported.id, imported);
      }
    }
    return [...imports.values()];
  }

  /** Symbols that use the referenced type in a parameter, return, or property. */
  findTypeUsers(ref: string): GraphNode[] {
    const targets = this.resolve(ref);
    const users = new Map<string, GraphNode>();
    for (const target of targets) {
      for (const edge of this.store.edgesTo(target.id, "UsesType")) {
        const user = this.store.getNode(edge.from);
        if (user) users.set(user.id, user);
      }
    }
    return [...users.values()];
  }

  /** Types the referenced symbol uses in a parameter, return, or property. */
  findTypesUsed(ref: string): GraphNode[] {
    const sources = this.resolve(ref);
    const types = new Map<string, GraphNode>();
    for (const source of sources) {
      for (const edge of this.store.edgesFrom(source.id, "UsesType")) {
        const type = this.store.getNode(edge.to);
        if (type) types.set(type.id, type);
      }
    }
    return [...types.values()];
  }

  /**
   * Everything about one node in a single call: its definition plus full
   * source, callers, callees, and dependents — a higher-order composition of
   * the individual query methods so an agent gets the whole picture at once.
   * Undefined when the ref resolves to nothing.
   */
  node(ref: string): NodeView | undefined {
    const primary = this.resolve(ref)[0];
    if (!primary) return undefined;
    return {
      node: primary,
      snippet: this.getCodeSnippet(ref),
      callers: this.findCallers(ref),
      callees: this.findCallees(ref),
      dependents: this.findImporters(ref),
    };
  }

  /**
   * The transitive blast radius of a symbol: everything affected by changing it,
   * found by walking the reverse "Calls" edges breadth-first (callers, then
   * callers of callers, …). `maxDepth` bounds the traversal (default unbounded);
   * a visited set makes cycles and recursion safe. The seed symbol(s) the ref
   * resolves to are excluded from the result.
   */
  impactAnalysis(ref: string, maxDepth = Number.POSITIVE_INFINITY): GraphNode[] {
    const seen = new Set(this.resolve(ref).map((n) => n.id));
    const affected = new Map<string, GraphNode>();
    let frontier = [...seen];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of this.store.edgesTo(id, "Calls")) {
          if (seen.has(edge.from)) continue;
          seen.add(edge.from);
          const caller = this.store.getNode(edge.from);
          if (caller) {
            affected.set(caller.id, caller);
            next.push(caller.id);
          }
        }
      }
      frontier = next;
    }
    return [...affected.values()];
  }

  /**
   * A census of the graph: how many nodes of each kind and edges of each kind
   * the index holds. Each edge is counted once, at its source node.
   */
  getGraphSchema(): GraphSchema {
    const nodes: Record<string, number> = {};
    const edges: Record<string, number> = {};
    for (const node of this.store.allNodes()) {
      nodes[node.kind] = (nodes[node.kind] ?? 0) + 1;
      for (const edge of this.store.edgesFrom(node.id)) {
        edges[edge.kind] = (edges[edge.kind] ?? 0) + 1;
      }
    }
    return { nodes, edges };
  }

  /**
   * The files affected by changing the given files: the transitive set of files
   * that import from them — directly (a module import) or by importing a symbol
   * they define — walked breadth-first. The input files are excluded. Answers
   * "which files (and tests) should I recheck?". Non-file refs and unknowns
   * contribute nothing.
   */
  affected(refs: string[]): GraphNode[] {
    const seeds = new Set<string>();
    for (const ref of refs) {
      for (const node of this.resolve(ref)) {
        if (node.kind === "File") seeds.add(node.id);
      }
    }
    const seen = new Set(seeds);
    const result = new Map<string, GraphNode>();
    let frontier = [...seeds];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const fileId of frontier) {
        for (const importer of this.fileImporters(fileId)) {
          if (seen.has(importer.id)) continue;
          seen.add(importer.id);
          result.set(importer.id, importer);
          next.push(importer.id);
        }
      }
      frontier = next;
    }
    return [...result.values()];
  }

  /**
   * Files that import from `fileId`: importers of the module itself (a star
   * re-export or namespace import targets the File node) plus importers of each
   * symbol the file defines.
   */
  private fileImporters(fileId: string): GraphNode[] {
    const importers = new Map<string, GraphNode>();
    const collect = (targetId: string) => {
      for (const edge of this.store.edgesTo(targetId, "Imports")) {
        const file = this.store.getNode(edge.from);
        if (file) importers.set(file.id, file);
      }
    };
    collect(fileId);
    for (const edge of this.store.edgesFrom(fileId, "Defines")) {
      collect(edge.to);
    }
    return [...importers.values()];
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
