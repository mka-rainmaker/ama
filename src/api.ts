/**
 * Public programmatic API — embed Ama as a library, not only run it as an MCP server/CLI.
 * Index a repository and query its code graph from your own code, the same surface the MCP
 * server and CLI use. {@link AmaSession} is the transport-free facade (every query method
 * lives on it); {@link index} is the one-call entry point.
 *
 * @example
 * ```ts
 * import { index } from "@mka-rainmaker/ama";
 *
 * const ama = await index("/path/to/repo");
 * ama.searchSymbol("createServer");   // GraphNode[]
 * ama.findCallers("createServer");    // who calls it (EdgeNeighbor[])
 * ama.impactAnalysis("AmaSession");   // transitive blast radius
 * ama.close();                        // release resources when done
 * ```
 */
import { AmaSession } from "./mcp/session.js";

export { AmaSession, AmaSession as Ama };
export type { IndexStatus } from "./mcp/session.js";

/**
 * Index a repository and return a ready-to-query {@link AmaSession} — a convenience over
 * `new AmaSession()` + `indexRepository(root)`. Call {@link AmaSession.close} when done.
 */
export async function index(root: string): Promise<AmaSession> {
  const session = new AmaSession();
  await session.indexRepository(root);
  return session;
}

/**
 * Open a persisted index for `root` without re-analyzing (falling back to a full index when
 * none is reusable), returning a ready-to-query {@link AmaSession}.
 */
export async function open(root: string): Promise<AmaSession> {
  const session = new AmaSession();
  await session.open(root);
  return session;
}

// Core graph + query result types a consumer needs to read what the methods return.
export type { GraphEdge, GraphNode, NodeKind, SourceRange, Tier } from "./graph/index.js";
export type { IndexStats, LanguageCoverage } from "./indexer/indexer.js";
export type {
  EdgeNeighbor,
  Exploration,
  FileSkeleton,
  GraphSchema,
  NodeView,
  SearchOptions,
  SearchResult,
  Snippet,
} from "./query/service.js";
