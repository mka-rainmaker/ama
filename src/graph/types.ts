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
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export type EdgeKind = "Defines" | "Calls" | "Inherits" | "Implements" | "UsesType" | "Imports";

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

export interface GraphEdge {
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  kind: EdgeKind;
}
