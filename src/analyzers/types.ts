import type { GraphEdge, GraphNode, Tier } from "../graph/index.js";

/** How many references an analyzer tried to resolve vs actually resolved — the
 *  basis for an honest "resolution coverage" metric. (ama-m8k.12) */
export interface ResolutionStats {
  /** Call/construction sites inside a function (those that can become an edge). */
  callsTotal: number;
  /** Of those, how many resolved to a known target node (the rest are external
   *  or dynamic — library calls, computed dispatch). */
  callsResolved: number;
  /** The unresolved calls, counted by callee root name (e.g. `ts`, `console`,
   *  `path`) — what the code calls that Ama can't see. (ama-qbn) */
  unresolved: Record<string, number>;
}

/** Nodes and edges produced by analyzing a set of files. */
export interface AnalysisResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Resolution coverage, when the analyzer measures it. Deep analyzers report
   *  it; a baseline (syntactic) analyzer resolves nothing, so it omits this. */
  resolution?: ResolutionStats;
}

/**
 * A per-language analyzer. Each declares its capability {@link Tier} so every
 * result can be attributed honestly: a `baseline` (syntactic) analyzer must
 * never be mistaken for `deep` (semantic) coverage.
 */
export interface Analyzer {
  /** Human-readable language name, e.g. "typescript". */
  readonly language: string;
  /** Capability tier this analyzer reports. */
  readonly tier: Tier;
  /** File extensions this analyzer handles, including the dot, e.g. [".ts"]. */
  readonly extensions: readonly string[];
  /**
   * Analyze `files` (repo-relative paths) rooted at the absolute `root`,
   * returning the nodes and edges they define.
   */
  analyze(root: string, files: string[]): AnalysisResult | Promise<AnalysisResult>;

  /**
   * Whether this analyzer can actually run right now. In-process analyzers omit it
   * (always available); an out-of-process sidecar probes its subprocess so routing can
   * prefer it only when present, falling back to baseline otherwise. (ama-3bb.4)
   */
  isAvailable?(): boolean | Promise<boolean>;
}
