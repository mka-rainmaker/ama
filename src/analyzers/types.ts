import type { GraphEdge, GraphNode, Tier } from "../graph/index.js";

/** Nodes and edges produced by analyzing a set of files. */
export interface AnalysisResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
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
}
