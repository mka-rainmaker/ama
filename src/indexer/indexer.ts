import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BaselineAnalyzer } from "../analyzers/baseline/analyzer.js";
import { cSpec, cppSpec } from "../analyzers/baseline/c.js";
import { csharpSpec } from "../analyzers/baseline/csharp.js";
import { goSpec } from "../analyzers/baseline/go.js";
import { javaSpec } from "../analyzers/baseline/java.js";
import { javascriptSpec } from "../analyzers/baseline/javascript.js";
import { phpSpec } from "../analyzers/baseline/php.js";
import { pythonSpec } from "../analyzers/baseline/python.js";
import { rustSpec } from "../analyzers/baseline/rust.js";
import { AnalyzerRegistry } from "../analyzers/registry.js";
import type { AnalysisResult, Analyzer, ResolutionStats } from "../analyzers/types.js";
import { TypeScriptAnalyzer } from "../analyzers/typescript/analyzer.js";
import type { Tier } from "../graph/index.js";
import { InMemoryStore } from "../store/memory.js";
import type { FileMeta, Store } from "../store/types.js";
import { MAX_FILE_SIZE_BYTES, isIgnoredSegment } from "./ignore.js";

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
  /** Aggregate call-resolution coverage across deep analyzers, when measured. */
  resolution?: ResolutionStats;
}

/**
 * Bumped whenever the persisted store's schema or the shape of what we write
 * into it changes. A persisted index stamped with a different version is treated
 * as unusable and rebuilt rather than reopened.
 */
const SCHEMA_VERSION = 4; // 2: provenance (m8k.1); 3: source-location (hft.9); 4: call sites (hft.10)

/** What a catch-up {@link Indexer.sync} reconciled. */
export interface SyncResult {
  /** Repo-relative paths re-indexed because they were new or modified. */
  changed: string[];
  /** Repo-relative paths dropped because they no longer exist (or analyze). */
  removed: string[];
}

/** Absolute directories far too broad to index — likely to pull in secrets,
 *  exhaust memory, or never finish. A real project lives in a subdirectory, so
 *  refusing these never blocks legitimate use. (ama-m8k.10) */
const UNSAFE_DIRS = new Set(
  [
    "/usr",
    "/etc",
    "/bin",
    "/sbin",
    "/var",
    "/opt",
    "/lib",
    "/dev",
    "/proc",
    "/System",
    "/Library",
  ].map((p) => path.resolve(p)),
);

/** Throw if `root` resolves to the filesystem root, the user's home directory,
 *  or a well-known system directory — a guardrail so a stray `index_repository`
 *  call (an agent, a typo) can't walk the whole machine. (ama-m8k.10) */
export function assertSafeRoot(root: string): void {
  const abs = path.resolve(root);
  if (abs === path.parse(abs).root || abs === path.resolve(os.homedir()) || UNSAFE_DIRS.has(abs)) {
    throw new Error(
      `Refusing to index ${abs}: that's the filesystem root, your home directory, or a system directory — far too broad. Point Ama at a specific project directory.`,
    );
  }
}

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
    // Refuse dangerously broad roots before touching the filesystem.
    assertSafeRoot(root);
    // A clear error beats a raw ENOTDIR/ENOENT when the root isn't a directory.
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Not a directory: ${root}`);
    }
    // Discover files BEFORE touching the store: a failing walk must not clear a
    // persistent store reused across indexes — that corrupts the live index.
    // Walking first keeps a failed re-index a no-op.
    const files = discoverFiles(root);
    const store = this.createStore();
    store.clear(); // a persistent store may hold a previous index; rebuild clean

    const byAnalyzer = new Map<Analyzer, string[]>();
    for (const rel of files) {
      const analyzer = this.registry.forFile(rel);
      if (!analyzer) continue;
      const list = byAnalyzer.get(analyzer);
      if (list) list.push(rel);
      else byAnalyzer.set(analyzer, [rel]);
    }

    const languages: LanguageCoverage[] = [];
    const resolution: ResolutionStats = { callsTotal: 0, callsResolved: 0, unresolved: {} };
    let fileCount = 0;
    for (const [analyzer, files] of byAnalyzer) {
      // Isolate each analyzer: a crash on one language's batch (a pathological
      // file, an analyzer bug) must not abort the whole index — the other
      // languages still produce a usable graph. The failure is reported to
      // stderr (never silently dropped) and that language is left out of
      // coverage so the index honestly reflects what was analyzed. (ama-m8k.9)
      let result: AnalysisResult;
      try {
        result = await analyzer.analyze(root, files);
      } catch (err) {
        console.error(
          `[ama] ${analyzer.language} analyzer failed on ${files.length} file(s); ` +
            `skipping them. ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      for (const n of result.nodes) store.addNode(n);
      for (const e of result.edges) store.addEdge(e);
      for (const rel of files) store.recordFile(fingerprint(root, rel));
      fileCount += files.length;
      if (result.resolution) {
        resolution.callsTotal += result.resolution.callsTotal;
        resolution.callsResolved += result.resolution.callsResolved;
        for (const [name, n] of Object.entries(result.resolution.unresolved)) {
          resolution.unresolved[name] = (resolution.unresolved[name] ?? 0) + n;
        }
      }
      languages.push({
        language: analyzer.language,
        tier: analyzer.tier,
        files: files.length,
      });
    }

    // Persist enough to reopen this index next process without re-analyzing:
    // coverage + resolution (for index_status), the root it was built for, and
    // the schema version that wrote it.
    store.setMeta("ama:coverage", JSON.stringify({ fileCount, languages }));
    store.setMeta("ama:resolution", JSON.stringify(resolution));
    store.setMeta("ama:root", root);
    store.setMeta("ama:schema", String(SCHEMA_VERSION));

    return {
      store,
      stats: {
        root,
        nodeCount: store.nodeCount,
        edgeCount: store.edgeCount,
        fileCount,
        languages,
        resolution,
      },
    };
  }

  /**
   * Reopen a previously-persisted index without re-analyzing: open the store and,
   * if it holds a usable index for `root` (matching schema version and root, with
   * nodes present), reconstruct its {@link IndexStats} from the persisted
   * coverage metadata. Returns undefined — and closes the freshly-opened store —
   * when there is nothing usable (an empty in-memory store, a different root, or
   * an incompatible schema), so the caller falls back to a full {@link index}.
   */
  async open(root: string): Promise<{ store: Store; stats: IndexStats } | undefined> {
    const store = this.createStore();
    const coverageRaw = store.getMeta("ama:coverage");
    const usable =
      store.getMeta("ama:schema") === String(SCHEMA_VERSION) &&
      store.getMeta("ama:root") === root &&
      store.nodeCount > 0 &&
      coverageRaw !== undefined;
    if (!usable) {
      store.close();
      return undefined;
    }
    const { fileCount, languages } = JSON.parse(coverageRaw) as {
      fileCount: number;
      languages: LanguageCoverage[];
    };
    // Resolution coverage is additive — an index written before ama-m8k.12 simply
    // lacks it, so it stays undefined rather than gating reopen.
    const resolutionRaw = store.getMeta("ama:resolution");
    const parsedResolution = resolutionRaw
      ? (JSON.parse(resolutionRaw) as ResolutionStats)
      : undefined;
    // An index written before ama-qbn has no `unresolved` map; default it so the
    // field is always present once `resolution` is.
    const resolution = parsedResolution
      ? { ...parsedResolution, unresolved: parsedResolution.unresolved ?? {} }
      : undefined;
    return {
      store,
      stats: {
        root,
        nodeCount: store.nodeCount,
        edgeCount: store.edgeCount,
        fileCount,
        languages,
        ...(resolution ? { resolution } : {}),
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

  /**
   * Catch-up reconcile: compare the tree on disk against the stored fingerprints
   * and re-index everything that drifted — files added or modified since the
   * last index, and files that have since vanished. Detection is cheap
   * (size + mtime, with a content hash only as the tiebreaker), and unchanged
   * files are skipped entirely. The manual counterpart to the live watcher.
   */
  async sync(store: Store, root: string): Promise<SyncResult> {
    const changed: string[] = [];
    const removed: string[] = [];
    const current = new Set<string>();
    for (const rel of discoverFiles(root)) {
      if (this.registry.forFile(rel)) current.add(rel);
    }
    for (const rel of current) {
      const meta = store.getFile(rel);
      if (meta && !isStale(root, rel, meta)) continue;
      await this.reindexFile(store, root, rel);
      changed.push(rel);
    }
    for (const meta of store.allFiles()) {
      if (!current.has(meta.path)) {
        await this.reindexFile(store, root, meta.path); // gone on disk → removeFile
        removed.push(meta.path);
      }
    }
    return { changed, removed };
  }
}

/**
 * An indexer wired with the analyzers Ama ships today. Pass a `createStore`
 * factory to persist into SQLite instead of the default in-memory store.
 */
export function createDefaultIndexer(createStore?: () => Store): Indexer {
  const registry = new AnalyzerRegistry();
  registry.register(new TypeScriptAnalyzer());
  registry.register(new BaselineAnalyzer(pythonSpec));
  registry.register(new BaselineAnalyzer(javascriptSpec));
  registry.register(new BaselineAnalyzer(javaSpec));
  registry.register(new BaselineAnalyzer(csharpSpec));
  registry.register(new BaselineAnalyzer(goSpec));
  registry.register(new BaselineAnalyzer(rustSpec));
  registry.register(new BaselineAnalyzer(phpSpec));
  registry.register(new BaselineAnalyzer(cSpec));
  registry.register(new BaselineAnalyzer(cppSpec));
  return new Indexer(registry, createStore);
}

/** Fingerprint a file for staleness tracking: size, mtime, and content hash. */
function fingerprint(root: string, rel: string): FileMeta {
  const abs = path.resolve(root, rel);
  const stat = fs.statSync(abs);
  const hash = crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
  return { path: rel, size: stat.size, mtimeMs: stat.mtimeMs, hash };
}

/**
 * Whether a file differs from its recorded fingerprint. Size and mtime are the
 * cheap first check; the content hash is consulted only when they are
 * inconclusive (mtime can change without the bytes changing), so an unchanged
 * file is never re-hashed.
 */
function isStale(root: string, rel: string, meta: FileMeta): boolean {
  const abs = path.resolve(root, rel);
  const stat = fs.statSync(abs);
  if (stat.size === meta.size && stat.mtimeMs === meta.mtimeMs) return false;
  const hash = crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
  return hash !== meta.hash;
}

/** Repo-relative paths of every file under `root`, skipping ignored trees. */
function discoverFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isIgnoredSegment(entry.name)) continue; // dotfiles + ignored dirs
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        // Skip oversized files (minified bundles, data blobs) — the same cap the
        // watcher enforces, so the initial index and re-index agree. A vanished
        // file is just skipped.
        let size: number;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_SIZE_BYTES) continue;
        out.push(path.relative(root, abs));
      }
    }
  };
  walk(root);
  return out;
}
