import * as path from "node:path";
import type { GraphNode } from "../graph/index.js";
import { Debouncer } from "../indexer/debouncer.js";
import { createDefaultIndexer } from "../indexer/indexer.js";
import type { IndexStats, Indexer, LanguageCoverage, SyncResult } from "../indexer/indexer.js";
import { FileWatcher } from "../indexer/watcher.js";
import { QueryService } from "../query/service.js";
import type { SearchOptions, Snippet } from "../query/service.js";
import type { Store } from "../store/types.js";

/** Default quiet window before a burst of edits triggers a re-index. */
const DEFAULT_DEBOUNCE_MS = 200;

export type IndexStatus =
  | { indexed: false }
  | {
      indexed: true;
      root: string;
      nodeCount: number;
      edgeCount: number;
      fileCount: number;
      languages: LanguageCoverage[];
      /** Edits the auto-syncer has queued but not yet re-indexed (0 if not watching). */
      pendingSync: number;
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
    this.store = store;
    this.query = new QueryService(store, abs);
    this.stats = stats;
    this.needsCatchUp = false; // a fresh index is already current
    return stats;
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
  watch(options: { windowMs?: number } = {}): void {
    if (!this.store || !this.stats) {
      throw new Error("Nothing indexed yet — call index_repository first.");
    }
    if (this.watcher) return; // already watching
    this.debouncer = new Debouncer(
      (rel) => this.reindexFile(rel).then(() => undefined),
      options.windowMs ?? DEFAULT_DEBOUNCE_MS,
    );
    this.watcher = new FileWatcher(this.stats.root, (rel) => this.debouncer?.notify(rel));
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
    if (!this.stats) return { indexed: false };
    const { root, nodeCount, edgeCount, fileCount, languages } = this.stats;
    return {
      indexed: true,
      root,
      nodeCount,
      edgeCount,
      fileCount,
      languages,
      pendingSync: this.debouncer?.pendingCount ?? 0,
    };
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
