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
