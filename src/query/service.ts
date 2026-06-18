import * as fs from "node:fs";
import * as path from "node:path";
import type { EdgeKind, EdgeProvenance, GraphEdge, GraphNode, NodeKind } from "../graph/index.js";
import type { FileMeta, Store } from "../store/types.js";

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

/** A neighbour reached across one edge, carrying that edge's metadata: the
 *  call-site location (ama-hft.9) and provenance (ama-m8k.1). Returned by
 *  find_callers/find_callees so an agent sees not just who, but where. */
export interface EdgeNeighbor {
  /** The symbol at the other end of the edge (the caller, or the callee). */
  symbol: GraphNode;
  /** Which edge kind connected them — e.g. `Calls` vs `Instantiates` (a `new X()`
   *  construction), so the two are separable in one result. (ama-hft.11) */
  via: EdgeKind;
  /** The call-site line/column, when the edge records one. */
  at?: { line: number; column: number };
  /** How the edge was derived; absent ⇒ resolved. */
  provenance?: EdgeProvenance;
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
  /** Symbols that reference it via a References edge — variable readers, the
   *  routes that map to a handler, and other dispatch references. */
  referrers: GraphNode[];
  /** Files that import (or re-export) it. */
  dependents: GraphNode[];
}

/** A file's structure in one answer: the symbols it defines and what depends on
 *  it — a structured, cheaper stand-in for reading the whole file. */
export interface FileSkeleton {
  /** The resolved File node. */
  file: GraphNode;
  /** Symbols the file defines, in source order (its outline). */
  symbols: GraphNode[];
  /** Files that import (or re-export) this file. */
  dependents: GraphNode[];
}

/** A census of the graph's node and edge kinds — what the index actually contains. */
export interface GraphSchema {
  /** Count of nodes per kind (e.g. Class, Function, Method, Interface, File). */
  nodes: Record<string, number>;
  /** Count of edges per kind (e.g. Defines, Calls, Imports, Implements, UsesType). */
  edges: Record<string, number>;
  /** How many edges are checker-`resolved` vs `heuristic` (route/synthesized) —
   *  edge-level tier honesty (ama-m8k.1). */
  edgeProvenance: { resolved: number; heuristic: number };
}

/** A one-call overview of a question: matching symbols grouped by file, their
 *  caller/callee relationships, and the combined transitive blast radius. */
export interface Exploration {
  question: string;
  /** Symbols whose name matches the question, grouped by their file. */
  byFile: Record<string, GraphNode[]>;
  /** For each match: who calls it and what it calls. */
  relationships: { symbol: string; callers: GraphNode[]; callees: GraphNode[] }[];
  /** Transitive callers of all matches — what changing them would affect. */
  blastRadius: GraphNode[];
}

/** A search query split into free text and structured filters (ama-m8k.3). */
export interface SearchQuery {
  /** Free text matched against symbol name / qualified name. */
  text: string;
  /** File-path substring filter (`path:src/api`). */
  path?: string;
  /** Node-kind filter (`kind:Function`), matched case-insensitively. */
  kind?: string;
  /** Language filter (`lang:python`), derived from the file extension. */
  lang?: string;
  /** Explicit name-substring filter (`name:handler`), in addition to free text. */
  name?: string;
}

// key:"quoted value" | key:bare | "quoted text" | bare-word.
const SEARCH_TOKEN = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]+)"|(\S+)/g;

/**
 * Parse a search string into free text plus `path:`/`kind:`/`lang:`/`name:`
 * filters, honouring quotes for values with spaces. Unknown `key:value` tokens
 * (e.g. a `http://…` URL) are kept verbatim as free text rather than dropped.
 */
export function parseSearchQuery(raw: string): SearchQuery {
  const result: SearchQuery = { text: "" };
  const text: string[] = [];
  for (const m of raw.matchAll(SEARCH_TOKEN)) {
    const key = m[1] ?? m[3];
    const value = m[2] ?? m[4];
    if (key !== undefined && value !== undefined) {
      switch (key.toLowerCase()) {
        case "path":
          result.path = value;
          break;
        case "kind":
          result.kind = value;
          break;
        case "lang":
          result.lang = value;
          break;
        case "name":
          result.name = value;
          break;
        default:
          text.push(`${key}:${value}`); // unknown filter — keep as text
      }
    } else {
      const bare = m[5] ?? m[6];
      if (bare !== undefined) text.push(bare);
    }
  }
  result.text = text.join(" ");
  return result;
}

/** Source-file extension → language name, for the `lang:` search filter. A small
 *  presentation-layer map (the authoritative extension set lives in each analyzer,
 *  which the query layer must not import). */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
};

function languageForFile(file: string): string | undefined {
  const dot = file.lastIndexOf(".");
  return dot === -1 ? undefined : LANGUAGE_BY_EXT[file.slice(dot).toLowerCase()];
}

/** Relevance weight per node kind — top-level definitions outrank members and
 *  variables when match quality ties. */
const KIND_BONUS: Partial<Record<NodeKind, number>> = {
  Class: 8,
  Interface: 8,
  Function: 8,
  Enum: 6,
  TypeAlias: 6,
  Module: 6,
  Route: 4,
  Method: 2,
  Property: 1,
  Variable: 1,
};

/** Whether a path looks like a test file — `tests/`/`__tests__/` dirs or a
 *  `.test.`/`.spec.` name. Used by test-impact filtering (ama-5gs.9) and search
 *  demotion. */
export function isTestFile(file: string): boolean {
  const f = file.toLowerCase();
  return /(^|\/)(tests?|__tests__)\//.test(f) || /\.(test|spec)\./.test(f);
}

/** Test and generated/build files — real but rarely the symbol you searched for,
 *  so a match there is demoted below an equivalent match in source. */
function isDeprioritizedFile(file: string): boolean {
  const f = file.toLowerCase();
  return (
    isTestFile(file) ||
    f.endsWith(".d.ts") ||
    /\.generated\./.test(f) ||
    /(^|\/)(dist|build|coverage)\//.test(f)
  );
}

/**
 * A relevance score for a symbol against the free-text part of a search. Higher
 * is better: exact name/qualified-name match dominates, then prefix, then
 * substring; a brevity bonus favours the more specific (shorter) name; a kind
 * bonus lifts top-level definitions; test/generated files are demoted. With no
 * free text (a filters-only query) only the kind/demotion terms apply. (ama-m8k.2)
 */
function scoreSymbol(node: GraphNode, query: string): number {
  let score = KIND_BONUS[node.kind] ?? 0;
  if (isDeprioritizedFile(node.file)) score -= 50;
  if (query) {
    const q = query.toLowerCase();
    const name = node.name.toLowerCase();
    const qn = node.qualifiedName.toLowerCase();
    if (name === q || qn === q) score += 100;
    else if (name.startsWith(q)) score += 60;
    else if (name.includes(q)) score += 30;
    else if (qn.includes(q)) score += 12; // matched only via the qualified name
    score += Math.max(0, 16 - name.length); // brevity: a shorter name is more specific
  }
  return score;
}

/**
 * Order relationship results (callers, callees, importers, …) by relevance with no
 * free-text term: the query-less `scoreSymbol` lifts top-level definitions over
 * members/variables and demotes test/generated files, so a symbol's real source
 * relationships surface above its test-file ones. Ties break alphabetically. (ama-bc2)
 */
function rankNodes(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort(
    (a, b) =>
      scoreSymbol(b, "") - scoreSymbol(a, "") || a.qualifiedName.localeCompare(b.qualifiedName),
  );
}

/** The edge kinds that mean "X invokes Y": a plain call and a `new Y()`
 *  construction. find_callers/find_callees report both, labelled by `via`. */
const CALL_EDGE_KINDS = ["Calls", "Instantiates"] as const satisfies readonly EdgeKind[];

/** The edge kinds that mean "X uses type Y" — a param/property annotation and a
 *  return type. find_types_used/find_type_users report both; find_returns is the
 *  return half alone. (ama-37c) */
const TYPE_EDGE_KINDS = ["UsesType", "Returns"] as const satisfies readonly EdgeKind[];

/** Pair a neighbour node with the metadata of the edge it was reached by. */
function neighbor(symbol: GraphNode, edge: GraphEdge): EdgeNeighbor {
  const n: EdgeNeighbor = { symbol, via: edge.kind };
  if (edge.at) n.at = edge.at;
  if (edge.provenance) n.provenance = edge.provenance;
  return n;
}

/** {@link rankNodes} for edge neighbours — ranks by the neighbour symbol. */
function rankNeighbors(neighbors: EdgeNeighbor[]): EdgeNeighbor[] {
  return [...neighbors].sort(
    (a, b) =>
      scoreSymbol(b.symbol, "") - scoreSymbol(a.symbol, "") ||
      a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName),
  );
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
    const { text, path: pathFilter, kind: kindFilter, lang, name } = parseSearchQuery(query);
    const limit = opts.limit ?? 50;
    const kind = kindFilter ?? opts.kind;
    // Free text searches the name index (relevance-ordered); a filters-only query
    // (e.g. `path:src/api kind:Class`) scans every node since there's no name term.
    const candidates = text
      ? this.store.searchByName(text, Number.MAX_SAFE_INTEGER)
      : this.store.allNodes();
    const hits: GraphNode[] = [];
    for (const node of candidates) {
      if (kind && node.kind.toLowerCase() !== kind.toLowerCase()) continue;
      if (pathFilter && !node.file.toLowerCase().includes(pathFilter.toLowerCase())) continue;
      if (lang && languageForFile(node.file) !== lang.toLowerCase()) continue;
      if (
        name &&
        !node.name.toLowerCase().includes(name.toLowerCase()) &&
        !node.qualifiedName.toLowerCase().includes(name.toLowerCase())
      ) {
        continue;
      }
      hits.push(node);
    }
    // Rank by relevance (match quality, kind, test/generated demotion) then slice —
    // so the best matches survive the limit, not just the first ones found. (ama-m8k.2)
    const scored = hits.map((node) => ({ node, score: scoreSymbol(node, text) }));
    scored.sort(
      (a, b) => b.score - a.score || a.node.qualifiedName.localeCompare(b.node.qualifiedName),
    );
    return scored.slice(0, limit).map((s) => s.node);
  }

  /** Every indexed file's metadata, sorted by repo-relative path. */
  files(): FileMeta[] {
    return [...this.store.allFiles()].sort((a, b) => a.path.localeCompare(b.path));
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

  /** Symbols that call or construct the referenced symbol, each labelled by the
   *  edge kind (`Calls` / `Instantiates`) and its call-site location. */
  findCallers(ref: string): EdgeNeighbor[] {
    const callers = new Map<string, EdgeNeighbor>();
    for (const target of this.resolve(ref)) {
      for (const kind of CALL_EDGE_KINDS) {
        for (const edge of this.store.edgesTo(target.id, kind)) {
          const caller = this.store.getNode(edge.from);
          if (caller && !callers.has(caller.id)) callers.set(caller.id, neighbor(caller, edge));
        }
      }
    }
    return rankNeighbors([...callers.values()]);
  }

  /** Symbols the referenced symbol calls or constructs, each labelled by the edge
   *  kind (`Calls` / `Instantiates`) and its call-site location. */
  findCallees(ref: string): EdgeNeighbor[] {
    const callees = new Map<string, EdgeNeighbor>();
    for (const source of this.resolve(ref)) {
      for (const kind of CALL_EDGE_KINDS) {
        for (const edge of this.store.edgesFrom(source.id, kind)) {
          const callee = this.store.getNode(edge.to);
          if (callee && !callees.has(callee.id)) callees.set(callee.id, neighbor(callee, edge));
        }
      }
    }
    return rankNeighbors([...callees.values()]);
  }

  /** The handler symbols a route refers to (route → References → handler). */
  findHandlers(ref: string): EdgeNeighbor[] {
    const handlers = new Map<string, EdgeNeighbor>();
    for (const route of this.resolve(ref)) {
      for (const edge of this.store.edgesFrom(route.id, "References")) {
        const handler = this.store.getNode(edge.to);
        if (handler && !handlers.has(handler.id)) handlers.set(handler.id, neighbor(handler, edge));
      }
    }
    return rankNeighbors([...handlers.values()]);
  }

  /**
   * Everything that points at a symbol via a References edge: the readers of a
   * module-level Variable (ama-6k0), the routes that map to a handler (rme.1), and
   * any other dispatch reference. The general "who refers to this" — answers the
   * question `find_callers` can't, since reads aren't calls. (ama-pfm)
   */
  findReferrers(ref: string): EdgeNeighbor[] {
    const referrers = new Map<string, EdgeNeighbor>();
    for (const target of this.resolve(ref)) {
      for (const edge of this.store.edgesTo(target.id, "References")) {
        const referrer = this.store.getNode(edge.from);
        if (referrer && !referrers.has(referrer.id)) {
          referrers.set(referrer.id, neighbor(referrer, edge));
        }
      }
    }
    return rankNeighbors([...referrers.values()]);
  }

  /** The routes that map to a handler — the route-domain framing of
   *  {@link findReferrers} (a route References its handler). */
  findRoutes(ref: string): EdgeNeighbor[] {
    return this.findReferrers(ref);
  }

  /** The supertype methods a method overrides or implements (method → super). */
  findOverrides(ref: string): EdgeNeighbor[] {
    const result = new Map<string, EdgeNeighbor>();
    for (const source of this.resolve(ref)) {
      for (const edge of this.store.edgesFrom(source.id, "Overrides")) {
        const target = this.store.getNode(edge.to);
        if (target && !result.has(target.id)) result.set(target.id, neighbor(target, edge));
      }
    }
    return rankNeighbors([...result.values()]);
  }

  /** The subtype methods that override a method (who overrides this — incoming). */
  findOverriddenBy(ref: string): EdgeNeighbor[] {
    const result = new Map<string, EdgeNeighbor>();
    for (const target of this.resolve(ref)) {
      for (const edge of this.store.edgesTo(target.id, "Overrides")) {
        const source = this.store.getNode(edge.from);
        if (source && !result.has(source.id)) result.set(source.id, neighbor(source, edge));
      }
    }
    return rankNeighbors([...result.values()]);
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
    return rankNodes([...implementers.values()]);
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
    return rankNodes([...interfaces.values()]);
  }

  /** Edges representing an import of/by `id` — value (`Imports`) and type-only
   *  (`ImportsType`) alike — so importer/dependent/affected queries still count an
   *  `import type` (it's a compile-time dependency). (ama-bhf) */
  private importEdgesTo(id: string): GraphEdge[] {
    return [...this.store.edgesTo(id, "Imports"), ...this.store.edgesTo(id, "ImportsType")];
  }
  private importEdgesFrom(id: string): GraphEdge[] {
    return [...this.store.edgesFrom(id, "Imports"), ...this.store.edgesFrom(id, "ImportsType")];
  }

  /** Files that import (or re-export) the referenced symbol. */
  findImporters(ref: string): GraphNode[] {
    const targets = this.resolve(ref);
    const importers = new Map<string, GraphNode>();
    for (const target of targets) {
      for (const edge of this.importEdgesTo(target.id)) {
        const file = this.store.getNode(edge.from);
        if (file) importers.set(file.id, file);
      }
    }
    return rankNodes([...importers.values()]);
  }

  /** Symbols the referenced file imports (or re-exports). */
  findImports(ref: string): GraphNode[] {
    const sources = this.resolve(ref);
    const imports = new Map<string, GraphNode>();
    for (const source of sources) {
      for (const edge of this.importEdgesFrom(source.id)) {
        const imported = this.store.getNode(edge.to);
        if (imported) imports.set(imported.id, imported);
      }
    }
    return rankNodes([...imports.values()]);
  }

  /** Symbols that use the referenced type in a parameter, return, or property. */
  findTypeUsers(ref: string): GraphNode[] {
    const users = new Map<string, GraphNode>();
    for (const target of this.resolve(ref)) {
      for (const kind of TYPE_EDGE_KINDS) {
        for (const edge of this.store.edgesTo(target.id, kind)) {
          const user = this.store.getNode(edge.from);
          if (user) users.set(user.id, user);
        }
      }
    }
    return rankNodes([...users.values()]);
  }

  /** Types the referenced symbol uses in a parameter, return, or property. */
  findTypesUsed(ref: string): GraphNode[] {
    const types = new Map<string, GraphNode>();
    for (const source of this.resolve(ref)) {
      for (const kind of TYPE_EDGE_KINDS) {
        for (const edge of this.store.edgesFrom(source.id, kind)) {
          const type = this.store.getNode(edge.to);
          if (type) types.set(type.id, type);
        }
      }
    }
    return rankNodes([...types.values()]);
  }

  /** The named types a symbol returns (function/method → its return type). */
  findReturns(ref: string): GraphNode[] {
    const types = new Map<string, GraphNode>();
    for (const source of this.resolve(ref)) {
      for (const edge of this.store.edgesFrom(source.id, "Returns")) {
        const type = this.store.getNode(edge.to);
        if (type) types.set(type.id, type);
      }
    }
    return rankNodes([...types.values()]);
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
      callers: this.findCallers(ref).map((c) => c.symbol),
      callees: this.findCallees(ref).map((c) => c.symbol),
      referrers: this.findReferrers(ref).map((c) => c.symbol),
      dependents: this.findImporters(ref),
    };
  }

  /**
   * A file's skeleton: the symbols it defines (its outline, in source order) plus
   * the files that depend on it — so an agent grasps a file's shape and reverse
   * dependencies from one call instead of reading the whole file. `ref` is a File
   * id (repo-relative path) or basename; non-file matches are ignored.
   */
  fileSkeleton(ref: string): FileSkeleton | undefined {
    const file = this.resolve(ref).find((n) => n.kind === "File");
    if (!file) return undefined;
    const symbols = [...this.store.allNodes()]
      .filter((n) => n.file === file.file && n.id !== file.id)
      .sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0));
    // Dependents = files importing *any* symbol the file defines, plus the file
    // itself (import * / export *). Imports edges target the imported declaration,
    // not the file node, so importers of named symbols would otherwise be missed.
    const dependents = new Map<string, GraphNode>();
    for (const target of [file, ...symbols]) {
      for (const edge of this.store.edgesTo(target.id, "Imports")) {
        const importer = this.store.getNode(edge.from);
        if (importer && importer.id !== file.id) dependents.set(importer.id, importer);
      }
    }
    return { file, symbols, dependents: [...dependents.values()] };
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
    const edgeProvenance = { resolved: 0, heuristic: 0 };
    for (const node of this.store.allNodes()) {
      nodes[node.kind] = (nodes[node.kind] ?? 0) + 1;
      for (const edge of this.store.edgesFrom(node.id)) {
        edges[edge.kind] = (edges[edge.kind] ?? 0) + 1;
        edgeProvenance[edge.provenance ?? "resolved"]++;
      }
    }
    return { nodes, edges, edgeProvenance };
  }

  /**
   * The files affected by changing the given files: the transitive set of files
   * that import from them — directly (a module import) or by importing a symbol
   * they define — walked breadth-first. The input files are excluded. Answers
   * "which files (and tests) should I recheck?". Non-file refs and unknowns
   * contribute nothing.
   */
  affected(refs: string[], opts: { testsOnly?: boolean } = {}): GraphNode[] {
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
    const all = [...result.values()];
    // Test-impact mode: keep only the affected test files — "which tests to run
    // for this change". (ama-5gs.9)
    return opts.testsOnly ? all.filter((n) => isTestFile(n.file)) : all;
  }

  /**
   * Files that import from `fileId`: importers of the module itself (a star
   * re-export or namespace import targets the File node) plus importers of each
   * symbol the file defines.
   */
  private fileImporters(fileId: string): GraphNode[] {
    const importers = new Map<string, GraphNode>();
    const collect = (targetId: string) => {
      for (const edge of this.importEdgesTo(targetId)) {
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

  /** The files this file imports: each Imports edge's target resolved to the file
   *  it lives in (a File node's id is its path, so that file is the target). */
  private fileImports(fileId: string): string[] {
    const deps = new Set<string>();
    for (const edge of this.store.edgesFrom(fileId, "Imports")) {
      const target = this.store.getNode(edge.to);
      if (target && target.file !== fileId) deps.add(target.file);
    }
    return [...deps];
  }

  /**
   * File-level import cycles, each a strongly-connected component of two or more
   * files that (transitively) import each other — the high-signal answer for
   * untangling a module graph. Tarjan's SCC over the file import graph; a
   * single-node component (no self-import) is not a cycle and is omitted. (ama-m8k.7)
   */
  circularImports(): GraphNode[][] {
    const files = [...this.store.allNodes()].filter((n) => n.kind === "File");
    const adjacency = new Map(files.map((f) => [f.id, this.fileImports(f.id)]));

    let counter = 0;
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];

    const connect = (v: string): void => {
      const vIndex = counter++;
      index.set(v, vIndex);
      low.set(v, vIndex);
      stack.push(v);
      onStack.add(v);
      for (const w of adjacency.get(v) ?? []) {
        const wIndex = index.get(w);
        if (wIndex === undefined) {
          connect(w);
          low.set(v, Math.min(low.get(v) ?? vIndex, low.get(w) ?? vIndex));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v) ?? vIndex, wIndex));
        }
      }
      if (low.get(v) === index.get(v)) {
        const component: string[] = [];
        let w: string | undefined;
        do {
          w = stack.pop();
          if (w === undefined) break;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        if (component.length > 1) components.push(component);
      }
    };

    for (const f of files) if (!index.has(f.id)) connect(f.id);

    const byId = new Map(files.map((f) => [f.id, f]));
    return components
      .map((component) =>
        component
          .flatMap((id) => {
            const node = byId.get(id);
            return node ? [node] : [];
          })
          .sort((a, b) => a.id.localeCompare(b.id)),
      )
      .sort((x, y) => (x[0]?.id ?? "").localeCompare(y[0]?.id ?? ""));
  }

  /**
   * A one-call overview answering "what's going on around X?": symbols whose
   * name matches `question`, grouped by file, each with its callers and callees,
   * plus the combined transitive blast radius. Composes searchSymbol,
   * findCallers/findCallees, and impactAnalysis — no new graph logic.
   */
  explore(question: string): Exploration {
    const matches = this.searchSymbol(question);
    const byFile: Record<string, GraphNode[]> = {};
    for (const match of matches) {
      const group = byFile[match.file] ?? [];
      group.push(match);
      byFile[match.file] = group;
    }
    const relationships = matches.map((match) => ({
      symbol: match.qualifiedName || match.name,
      callers: this.findCallers(match.id).map((c) => c.symbol),
      callees: this.findCallees(match.id).map((c) => c.symbol),
    }));
    const blast = new Map<string, GraphNode>();
    for (const match of matches) {
      for (const affected of this.impactAnalysis(match.id)) blast.set(affected.id, affected);
    }
    return { question, byFile, relationships, blastRadius: [...blast.values()] };
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
