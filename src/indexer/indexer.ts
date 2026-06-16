import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AnalyzerRegistry } from "../analyzers/registry.js";
import type { Analyzer } from "../analyzers/types.js";
import { TypeScriptAnalyzer } from "../analyzers/typescript/analyzer.js";
import type { Tier } from "../graph/index.js";
import { InMemoryStore } from "../store/memory.js";
import type { FileMeta, Store } from "../store/types.js";

export interface LanguageCoverage {
  language: string;
  tier: Tier;
  files: number;
}

export interface IndexStats {
  /** Absolute root that was indexed. */
  root: string;
  nodeCount: number;
  edgeCount: number;
  /** Number of source files actually analyzed. */
  fileCount: number;
  /** Per-language coverage, each carrying the analyzer's tier. */
  languages: LanguageCoverage[];
}

/** Directories never worth walking. Dot-directories are skipped separately. */
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

/**
 * Turns a directory into a graph: discover source files, hand each to the
 * analyzer that claims its extension, and collect the resulting nodes/edges
 * into a store. All files for one analyzer are analyzed together so it can
 * resolve cross-file references (e.g. an import's call target).
 */
export class Indexer {
  constructor(
    private readonly registry: AnalyzerRegistry,
    /** How to create the backing store — swap this to persist to SQLite. */
    private readonly createStore: () => Store = () => new InMemoryStore(),
  ) {}

  async index(root: string): Promise<{ store: Store; stats: IndexStats }> {
    const store = this.createStore();

    const byAnalyzer = new Map<Analyzer, string[]>();
    for (const rel of discoverFiles(root)) {
      const analyzer = this.registry.forFile(rel);
      if (!analyzer) continue;
      const list = byAnalyzer.get(analyzer);
      if (list) list.push(rel);
      else byAnalyzer.set(analyzer, [rel]);
    }

    const languages: LanguageCoverage[] = [];
    let fileCount = 0;
    for (const [analyzer, files] of byAnalyzer) {
      const { nodes, edges } = await analyzer.analyze(root, files);
      for (const n of nodes) store.addNode(n);
      for (const e of edges) store.addEdge(e);
      for (const rel of files) store.recordFile(fingerprint(root, rel));
      fileCount += files.length;
      languages.push({
        language: analyzer.language,
        tier: analyzer.tier,
        files: files.length,
      });
    }

    // Persist coverage so a reopened (SQLite-backed) index can report
    // index_status without re-analyzing.
    store.setMeta("ama:coverage", JSON.stringify({ fileCount, languages }));

    return {
      store,
      stats: {
        root,
        nodeCount: store.nodeCount,
        edgeCount: store.edgeCount,
        fileCount,
        languages,
      },
    };
  }

  /**
   * Re-index a single changed file into an existing store, in place. Re-analyzes
   * just `rel` and reconciles its delta (so an edit churns only what changed);
   * if `rel` was deleted or is no longer analyzable, its data is dropped instead.
   * Edges from `rel` into files this pass never walks still resolve, because the
   * analyzer falls back to location-derived ids for nodes already in the store.
   */
  async reindexFile(store: Store, root: string, rel: string): Promise<void> {
    const abs = path.resolve(root, rel);
    const analyzer = this.registry.forFile(rel);
    if (!analyzer || !fs.existsSync(abs)) {
      store.removeFile(rel);
      return;
    }
    const { nodes, edges } = await analyzer.analyze(root, [rel]);
    store.reconcileFile(rel, nodes, edges);
    store.recordFile(fingerprint(root, rel));
  }
}

/**
 * An indexer wired with the analyzers Ama ships today. Pass a `createStore`
 * factory to persist into SQLite instead of the default in-memory store.
 */
export function createDefaultIndexer(createStore?: () => Store): Indexer {
  const registry = new AnalyzerRegistry();
  registry.register(new TypeScriptAnalyzer());
  return new Indexer(registry, createStore);
}

/** Fingerprint a file for staleness tracking: size, mtime, and content hash. */
function fingerprint(root: string, rel: string): FileMeta {
  const abs = path.resolve(root, rel);
  const stat = fs.statSync(abs);
  const hash = crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
  return { path: rel, size: stat.size, mtimeMs: stat.mtimeMs, hash };
}

/** Repo-relative paths of every file under `root`, skipping ignored trees. */
function discoverFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue; // .git, .beads, dotfiles
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(abs);
      } else if (entry.isFile()) {
        out.push(path.relative(root, abs));
      }
    }
  };
  walk(root);
  return out;
}
