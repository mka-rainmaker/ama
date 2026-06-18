/**
 * Language-agnostic graph model: the vocabulary every analyzer emits and every
 * query reads. Kept deliberately small for the MVP; new kinds are added as
 * analyzers learn to resolve them.
 */

/** The node kinds, as a runtime array — the single source of truth (e.g. for
 * validating a `kind` filter). `NodeKind` is derived from it, so the two stay
 * in sync. */
export const NODE_KINDS = [
  "File",
  "Module",
  "Class",
  "Interface",
  "Enum",
  "TypeAlias",
  "Function",
  "Method",
  "Property",
  /** A module-level variable/constant binding, e.g. `const MAX_RETRIES = 3`. */
  "Variable",
  /** A framework route, e.g. "GET /users" — its handler is found via a References edge. */
  "Route",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export type EdgeKind =
  | "Defines"
  | "Calls"
  /** A `new X()` construction — distinct from a plain Calls so "who instantiates
   *  X" is separable from "who calls X". (ama-hft.11) */
  | "Instantiates"
  /** A subtype method that overrides/implements a supertype method of the same
   *  name (subtype.method → supertype.method). (ama-hft.11) */
  | "Overrides"
  | "Inherits"
  | "Implements"
  | "UsesType"
  /** A function/method → its declared return type, distinct from the param/property
   *  type usages of UsesType. (ama-37c) */
  | "Returns"
  | "Imports"
  /** A type-only import (`import type` / `import { type X }`) — a compile-time
   *  dependency erased at runtime. Counted as an import for dependents/affected,
   *  but excluded from runtime analyses like circular_imports. */
  | "ImportsType"
  /** A route (or other dispatch) refers to the symbol that handles it. */
  | "References";

/** Which analysis tier produced a piece of data. */
export type Tier = "deep" | "baseline";

/** 1-based, inclusive source span — used for snippet extraction, never for ids. */
export interface SourceRange {
  startLine: number;
  endLine: number;
}

export interface GraphNode {
  /** Stable, location-independent id (see {@link ./id.ts}). */
  id: string;
  kind: NodeKind;
  /** Simple (unqualified) name, e.g. "method". */
  name: string;
  /** Repo-relative file the symbol lives in, e.g. "src/a.ts". */
  file: string;
  /** Dotted qualified name within the file, e.g. "Cls.method". */
  qualifiedName: string;
  /** Source span for snippet extraction; absent for synthetic nodes. */
  range?: SourceRange;
  /** Tier of the analyzer that produced this node. */
  tier: Tier;
}

/**
 * How an edge was derived. `resolved` (the default when absent) means a
 * type-checker- or symbol-backed fact; `heuristic` means a pattern/string match
 * that isn't checker-verified (route detection, callback-handler synthesis). Lets
 * query results label edge trust — the node-level tier honesty rule, at edge level.
 */
export type EdgeProvenance = "resolved" | "heuristic";

export interface GraphEdge {
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  kind: EdgeKind;
  /** How the edge was derived; absent ⇒ `resolved`. */
  provenance?: EdgeProvenance;
  /** Where the edge originates — a call/new site's 1-based line and column. With
   *  dedup on (from,to,kind), this is the first such site. Absent for edges with
   *  no single source point (Defines, Imports). (ama-hft.9) */
  at?: { line: number; column: number };
  /** Every call/construction site for this edge, when a caller invokes a target
   *  more than once (`sites[0] === at`). Absent for single-site edges. (ama-hft.10) */
  sites?: { line: number; column: number }[];
}
