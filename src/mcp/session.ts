import * as path from "node:path";
import type { GraphNode } from "../graph/index.js";
import { createDefaultIndexer } from "../indexer/indexer.js";
import type { IndexStats, Indexer, LanguageCoverage } from "../indexer/indexer.js";
import { QueryService } from "../query/service.js";
import type { SearchOptions, Snippet } from "../query/service.js";

export type IndexStatus =
  | { indexed: false }
  | {
      indexed: true;
      root: string;
      nodeCount: number;
      edgeCount: number;
      fileCount: number;
      languages: LanguageCoverage[];
    };

/**
 * Stateful core behind the MCP tools. Holds the current index and routes the
 * tool calls (index_repository, index_status, and the query tools) to the
 * indexer and query service. Kept transport-free so it is unit-testable without
 * standing up a stdio server.
 */
export class AmaSession {
  private query?: QueryService;
  private stats?: IndexStats;

  constructor(private readonly indexer: Indexer = createDefaultIndexer()) {}

  async indexRepository(root: string): Promise<IndexStats> {
    const abs = path.resolve(root);
    const { store, stats } = await this.indexer.index(abs);
    this.query = new QueryService(store, abs);
    this.stats = stats;
    return stats;
  }

  indexStatus(): IndexStatus {
    if (!this.stats) return { indexed: false };
    const { root, nodeCount, edgeCount, fileCount, languages } = this.stats;
    return { indexed: true, root, nodeCount, edgeCount, fileCount, languages };
  }

  searchSymbol(query: string, opts?: SearchOptions): GraphNode[] {
    return this.requireQuery().searchSymbol(query, opts);
  }

  findCallers(ref: string): GraphNode[] {
    return this.requireQuery().findCallers(ref);
  }

  findCallees(ref: string): GraphNode[] {
    return this.requireQuery().findCallees(ref);
  }

  getCodeSnippet(ref: string): Snippet | undefined {
    return this.requireQuery().getCodeSnippet(ref);
  }

  private requireQuery(): QueryService {
    if (!this.query) {
      throw new Error("Nothing indexed yet — call index_repository first.");
    }
    return this.query;
  }
}
