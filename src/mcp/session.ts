import * as path from "node:path";
import type { ResolutionStats } from "../analyzers/types.js";
import type { GraphNode } from "../graph/index.js";
import { Debouncer } from "../indexer/debouncer.js";
import { createDefaultIndexer } from "../indexer/indexer.js";
import type { IndexStats, Indexer, LanguageCoverage, SyncResult } from "../indexer/indexer.js";
import { FileWatcher, type WatchSource } from "../indexer/watcher.js";
import { QueryService } from "../query/service.js";
import type {
  EdgeNeighbor,
  Exploration,
  FileSkeleton,
  GraphSchema,
  NodeView,
  SearchOptions,
  SearchResult,
  Snippet,
} from "../query/service.js";
import type { Store } from "../store/types.js";
import { type ServerStamp, serverStamp } from "./build-info.js";

/** Default quiet window before a burst of edits triggers a re-index. */
const DEFAULT_DEBOUNCE_MS = 200;

export type IndexStatus =
  | { indexed: false; server: ServerStamp }
  | {
      indexed: true;
      root: string;
      nodeCount: number;
      edgeCount: number;
      fileCount: number;
      languages: LanguageCoverage[];
      /** Call-resolution coverage (resolved vs total attributable call sites), when
       *  measured — an honest signal of how complete the call graph is. */
      resolution?: ResolutionStats;
      /** Edits the auto-syncer has queued but not yet re-indexed (0 if not watching). */
      pendingSync: number;
      /** Running-server build stamp, for detecting a stale server (see build-info). */
      server: ServerStamp;
    };

/**
 * Stateful core behind the MCP tools. Holds the current index and routes the
 * tool calls (index_repository, index_status, and the query tools) to the
 * indexer and query service. Kept transport-free so it is unit-testable without
 * standing up a stdio server.
 */
export class AmaSession {
  private store?: Store;
  private query?: QueryService;
  private stats?: IndexStats;
  private watcher?: FileWatcher;
  private debouncer?: Debouncer;
  private needsCatchUp = false;

  constructor(private readonly indexer: Indexer = createDefaultIndexer()) {}

  async indexRepository(root: string): Promise<IndexStats> {
    const abs = path.resolve(root);
    const { store, stats } = await this.indexer.index(abs);
    const previous = this.store;
    this.store = store;
    this.query = new QueryService(store, abs);
    this.stats = stats;
    this.needsCatchUp = false; // a fresh index is already current
    previous?.close();
    return stats;
  }

  /**
   * Open a persisted index for `root` without re-analyzing, falling back to a
   * full {@link indexRepository} when there is nothing usable to reopen (e.g. the
   * in-memory store, or a stale/incompatible DB). On reopen, drift is reconciled
   * lazily on the first query (the connect-time catch-up). Used at server
   * startup so a process restart reuses the persisted graph.
   */
  async open(root: string): Promise<IndexStats> {
    const abs = path.resolve(root);
    const opened = await this.indexer.open(abs);
    if (!opened) return this.indexRepository(abs);
    const previous = this.store;
    this.store = opened.store;
    this.query = new QueryService(opened.store, abs);
    this.stats = opened.stats;
    this.needsCatchUp = true; // reconcile anything that changed while we were down
    previous?.close();
    return opened.stats;
  }

  /** Release resources: stop watching and close the store. */
  close(): void {
    this.unwatch();
    this.store?.close();
    this.store = undefined;
  }

  /**
   * Arm a one-shot catch-up — typically on MCP reconnect, since files may have
   * changed while disconnected. A no-op until something is indexed.
   */
  markForCatchUp(): void {
    if (this.stats) this.needsCatchUp = true;
  }

  /**
   * If armed, reconcile on-disk changes before serving (a size/mtime + hash
   * diff via {@link sync}), then disarm. Returns what it reconciled, or
   * undefined when nothing was armed. Called before each query so the first one
   * after a reconnect sees a current graph.
   */
  async catchUpIfNeeded(): Promise<SyncResult | undefined> {
    if (!this.needsCatchUp) return undefined;
    this.needsCatchUp = false;
    return this.sync();
  }

  /**
   * Re-index a single file that changed on disk, updating the live graph in
   * place (no full rebuild, same store, so existing queries keep working).
   * Counts are refreshed; language coverage is unchanged by a single-file edit.
   */
  async reindexFile(rel: string): Promise<IndexStats> {
    if (!this.store || !this.stats) {
      throw new Error("Nothing indexed yet — call index_repository first.");
    }
    await this.indexer.reindexFile(this.store, this.stats.root, rel);
    this.stats = {
      ...this.stats,
      nodeCount: this.store.nodeCount,
      edgeCount: this.store.edgeCount,
      fileCount: this.store.allFiles().length,
    };
    return this.stats;
  }

  /**
   * Start watching the indexed root and auto-re-index files as they change,
   * collapsing bursts of edits with a debounce window. Idempotent; requires a
   * prior index. Pair with {@link unwatch} to stop.
   */
  watch(options: { windowMs?: number; source?: WatchSource } = {}): void {
    if (!this.store || !this.stats) {
      throw new Error("Nothing indexed yet — call index_repository first.");
    }
    if (this.watcher) return; // already watching
    this.debouncer = new Debouncer(
      (rel) => this.reindexFile(rel).then(() => undefined),
      options.windowMs ?? DEFAULT_DEBOUNCE_MS,
    );
    this.watcher = new FileWatcher(this.stats.root, (rel) => this.debouncer?.notify(rel), {
      source: options.source,
    });
    this.watcher.start();
  }

  /** Stop watching. Pending (un-synced) edits are dropped. */
  unwatch(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.debouncer?.stop();
    this.debouncer = undefined;
  }

  /**
   * Manually reconcile files that changed on disk since the last index — a
   * catch-up that does not need a live watcher. Returns what it re-indexed and
   * removed, and refreshes the cached counts.
   */
  async sync(): Promise<SyncResult> {
    if (!this.store || !this.stats) {
      throw new Error("Nothing indexed yet — call index_repository first.");
    }
    const result = await this.indexer.sync(this.store, this.stats.root);
    this.stats = {
      ...this.stats,
      nodeCount: this.store.nodeCount,
      edgeCount: this.store.edgeCount,
      fileCount: this.store.allFiles().length,
    };
    return result;
  }

  /**
   * A warning to prepend to query results while edits sit in the auto-syncer's
   * debounce window: those files' results are stale until the next re-index, so
   * name them and steer the caller to read them directly. Undefined when there
   * is nothing pending (the common case — no banner).
   */
  stalenessBanner(): string | undefined {
    const pending = this.debouncer?.pendingPaths() ?? [];
    if (pending.length === 0) return undefined;
    const shown = pending.slice(0, 10);
    const more = pending.length - shown.length;
    const list = more > 0 ? `${shown.join(", ")}, and ${more} more` : shown.join(", ");
    return (
      `⚠️ Ama: ${pending.length} file(s) changed and are pending re-index — results below ` +
      `may be stale for: ${list}. For their current contents, read these files directly.`
    );
  }

  indexStatus(): IndexStatus {
    if (!this.stats) return { indexed: false, server: serverStamp };
    const { root, nodeCount, edgeCount, fileCount, resolution } = this.stats;
    return {
      indexed: true,
      root,
      nodeCount,
      edgeCount,
      fileCount,
      // Recompute coverage live from the current files: a full index writes the
      // cached `ama:coverage` metadata, but an incremental sync/reindex doesn't, so
      // the cached per-language census drifts. Deriving it from the store each call
      // keeps it correct on every path. (resolution still reflects the last full
      // index — it's analysis metadata, not derivable from the store.) (ama-okg)
      languages: this.coverage(),
      ...(resolution ? { resolution } : {}),
      pendingSync: this.debouncer?.pendingCount ?? 0,
      server: serverStamp,
    };
  }

  /** Live per-language file coverage from the current store, in first-seen order. */
  private coverage(): LanguageCoverage[] {
    const counts = new Map<string, { tier: LanguageCoverage["tier"]; files: number }>();
    for (const meta of this.store?.allFiles() ?? []) {
      const lang = this.indexer.languageOf(meta.path);
      if (!lang) continue;
      const entry = counts.get(lang.language);
      if (entry) entry.files++;
      else counts.set(lang.language, { tier: lang.tier, files: 1 });
    }
    return [...counts].map(([language, { tier, files }]) => ({ language, tier, files }));
  }

  searchSymbol(query: string, opts?: SearchOptions): GraphNode[] {
    return this.requireQuery().searchSymbol(query, opts);
  }

  searchSymbolWithConfidence(query: string, opts?: SearchOptions): SearchResult {
    return this.requireQuery().searchSymbolWithConfidence(query, opts);
  }

  searchCode(query: string, opts?: { limit?: number }): GraphNode[] {
    return this.requireQuery().searchCode(query, opts);
  }

  searchCodeWithConfidence(
    query: string,
    opts?: { limit?: number },
  ): { results: GraphNode[]; viaTerms: boolean } {
    return this.requireQuery().searchCodeWithConfidence(query, opts);
  }

  findCallers(ref: string): EdgeNeighbor[] {
    return this.requireQuery().findCallers(ref);
  }

  findCallees(ref: string): EdgeNeighbor[] {
    return this.requireQuery().findCallees(ref);
  }

  findHandlers(ref: string): EdgeNeighbor[] {
    return this.requireQuery().findHandlers(ref);
  }

  findRoutes(ref: string): EdgeNeighbor[] {
    return this.requireQuery().findRoutes(ref);
  }

  findReferrers(ref: string): EdgeNeighbor[] {
    return this.requireQuery().findReferrers(ref);
  }

  findOverrides(ref: string): EdgeNeighbor[] {
    return this.requireQuery().findOverrides(ref);
  }

  findOverriddenBy(ref: string): EdgeNeighbor[] {
    return this.requireQuery().findOverriddenBy(ref);
  }

  circularImports(): GraphNode[][] {
    return this.requireQuery().circularImports();
  }

  findImplementations(ref: string): GraphNode[] {
    return this.requireQuery().findImplementations(ref);
  }

  findInterfaces(ref: string): GraphNode[] {
    return this.requireQuery().findInterfaces(ref);
  }

  findImporters(ref: string): GraphNode[] {
    return this.requireQuery().findImporters(ref);
  }

  findImports(ref: string): GraphNode[] {
    return this.requireQuery().findImports(ref);
  }

  findTypeUsers(ref: string): GraphNode[] {
    return this.requireQuery().findTypeUsers(ref);
  }

  findTypesUsed(ref: string): GraphNode[] {
    return this.requireQuery().findTypesUsed(ref);
  }

  findReturns(ref: string): GraphNode[] {
    return this.requireQuery().findReturns(ref);
  }

  getCodeSnippet(ref: string): Snippet | undefined {
    return this.requireQuery().getCodeSnippet(ref);
  }

  node(ref: string): NodeView | undefined {
    return this.requireQuery().node(ref);
  }

  fileSkeleton(ref: string): FileSkeleton | undefined {
    return this.requireQuery().fileSkeleton(ref);
  }

  impactAnalysis(ref: string, maxDepth?: number): GraphNode[] {
    return this.requireQuery().impactAnalysis(ref, maxDepth);
  }

  getGraphSchema(): GraphSchema {
    return this.requireQuery().getGraphSchema();
  }

  affected(files: string[], opts: { testsOnly?: boolean } = {}): GraphNode[] {
    return this.requireQuery().affected(files, opts);
  }

  explore(question: string, opts: { limit?: number } = {}): Exploration {
    return this.requireQuery().explore(question, opts);
  }

  private requireQuery(): QueryService {
    if (!this.query) {
      throw new Error("Nothing indexed yet — call index_repository first.");
    }
    return this.query;
  }
}
