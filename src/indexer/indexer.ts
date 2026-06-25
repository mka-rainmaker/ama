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
import { kotlinSpec } from "../analyzers/baseline/kotlin.js";
import { phpSpec } from "../analyzers/baseline/php.js";
import { pythonSpec } from "../analyzers/baseline/python.js";
import { rustSpec } from "../analyzers/baseline/rust.js";
import { swiftSpec } from "../analyzers/baseline/swift.js";
import { DotenvAnalyzer } from "../analyzers/dotenv/analyzer.js";
import { JavaBytecodeAnalyzer } from "../analyzers/java-bytecode/analyzer.js";
import { JavaDeepAnalyzer } from "../analyzers/java-deep/analyzer.js";
import { PrismaAnalyzer } from "../analyzers/prisma/analyzer.js";
import { AnalyzerRegistry } from "../analyzers/registry.js";
import { SfcAnalyzer } from "../analyzers/sfc/analyzer.js";
import type { AnalysisResult, Analyzer, ResolutionStats } from "../analyzers/types.js";
import { TypeScriptAnalyzer } from "../analyzers/typescript/analyzer.js";
import {
  deriveCallEdges,
  deriveDispatchEdges,
  deriveEnvReferences,
  derivePrismaReferences,
  deriveRouteTestEdges,
  deriveTypeEdges,
} from "../graph/index.js";
import type { Tier } from "../graph/index.js";
import { InMemoryStore } from "../store/memory.js";
import type { FileMeta, Store } from "../store/types.js";
import {
  type IgnoreRules,
  MAX_FILE_SIZE_BYTES,
  isIgnoredPath,
  loadIgnoreRules,
  withNestedIgnore,
} from "./ignore.js";

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
const SCHEMA_VERSION = 7; // 2: provenance; 3: source-location; 4: call sites; 5: edge confidence/strategy; 6: capped resolution stats; 7: external nodes
const MAX_RESOLUTION_BREAKDOWN_ENTRIES = 100;

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
    /** How to create the backing store for a (resolved) project root — swap this to
     *  persist to SQLite. The root is passed so a multi-project session can give each
     *  project an independent store; a factory that ignores it and returns one shared
     *  store would alias every project onto the last index. (ama-mnj) */
    private readonly createStore: (root: string) => Store = () => new InMemoryStore(),
  ) {}

  /** The (language, tier) that owns a file, or undefined if no analyzer claims it.
   *  Lets a caller recompute per-language coverage live from the current file set,
   *  so index_status's census stays correct after incremental syncs — not only
   *  after a full index, which is the only thing that writes the cached coverage
   *  metadata. (ama-okg) */
  languageOf(rel: string): { language: string; tier: Tier } | undefined {
    const analyzer = this.registry.forFile(rel);
    return analyzer ? { language: analyzer.language, tier: analyzer.tier } : undefined;
  }

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
    const skippedLarge: string[] = [];
    const files = discoverFiles(root, (rel) => skippedLarge.push(rel));
    if (skippedLarge.length > 0) {
      // Honest about omissions, like the per-analyzer isolation below: a file too big
      // to parse safely is left out, but said so on stderr (stdout is JSON-RPC only).
      console.error(
        `[ama] skipped ${skippedLarge.length} file(s) over the ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB parse cap (too large to index): ${skippedLarge.join(", ")}`,
      );
    }
    const store = this.createStore(root);
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
    const resolution: ResolutionStats = {
      callsTotal: 0,
      callsResolved: 0,
      unresolved: emptyUnresolvedMap(),
      diagnostics: emptyUnresolvedMap(),
    };
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
      for (const rel of files) {
        const meta = fingerprint(root, rel);
        if (meta) store.recordFile(meta);
        else store.removeFile(rel); // vanished mid-index — drop its just-added nodes
      }
      fileCount += files.length;
      if (result.resolution) {
        resolution.callsTotal += result.resolution.callsTotal;
        resolution.callsResolved += result.resolution.callsResolved;
        resolution.unresolvedOther =
          (resolution.unresolvedOther ?? 0) + (result.resolution.unresolvedOther ?? 0);
        for (const [name, n] of Object.entries(result.resolution.unresolved)) {
          resolution.unresolved[name] = (resolution.unresolved[name] ?? 0) + n;
        }
        const diagnostics = resolution.diagnostics ?? emptyUnresolvedMap();
        resolution.diagnostics = diagnostics;
        resolution.diagnosticsOther =
          (resolution.diagnosticsOther ?? 0) + (result.resolution.diagnosticsOther ?? 0);
        for (const [reason, n] of Object.entries(result.resolution.diagnostics ?? {})) {
          diagnostics[reason] = (diagnostics[reason] ?? 0) + n;
        }
      }
      languages.push({
        language: analyzer.language,
        tier: result.tier ?? analyzer.tier,
        files: files.length,
      });
    }

    // Resolve cross-analyzer Prisma links now that every analyzer's nodes are in the
    // store — the TS `prisma-ref` candidates and the schema model nodes only meet here. (ama-kvv)
    relinkPrisma(store);
    relinkTypes(store); // resolve baseline type:<Name> candidates BEFORE dispatch (ama 0.4.0 S0)
    redispatch(store); // re-derive Overrides/dispatch over the now-resolved hierarchy (ama 0.4.0 S0)
    relinkCalls(store); // and cross-file baseline call edges (ama-bnj)
    relinkRouteTests(store); // and FastAPI TestClient route→test links (ama-f2c)
    relinkEnv(store); // and process.env → .env value-provenance links (#53)
    const publicResolution = compactResolutionStats(resolution);

    // Persist enough to reopen this index next process without re-analyzing:
    // coverage + resolution (for index_status), the root it was built for, and
    // the schema version that wrote it.
    store.setMeta("ama:coverage", JSON.stringify({ fileCount, languages }));
    store.setMeta("ama:resolution", JSON.stringify(publicResolution));
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
        // Only surface resolution when a deep analyzer actually measured it. A baseline-only index
        // resolves nothing, so an all-zero stat reads as a misleading "0 of 0" — omit it instead. (#45)
        ...(publicResolution.callsTotal > 0 ? { resolution: publicResolution } : {}),
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
    const store = this.createStore(root);
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
    // field is always present once `resolution` is. Drop an all-zero stat (a baseline-only index
    // measured nothing) so a reopen stays as honest as a fresh index — no misleading "0 of 0". (#45)
    const resolution =
      parsedResolution && parsedResolution.callsTotal > 0
        ? {
            ...parsedResolution,
            unresolved: nullPrototypeUnresolved(parsedResolution.unresolved),
            unresolvedOther: parsedResolution.unresolvedOther,
            diagnostics: nullPrototypeUnresolved(parsedResolution.diagnostics),
            diagnosticsOther: parsedResolution.diagnosticsOther,
          }
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
    const meta = analyzer && fs.existsSync(abs) ? fingerprint(root, rel) : null;
    if (!analyzer || !meta) {
      store.removeFile(rel); // unhandled language, or the file is gone
    } else {
      const { nodes, edges } = await analyzer.analyze(root, [rel]);
      store.reconcileFile(rel, nodes, edges);
      store.recordFile(meta);
    }
    // Dispatch fan-out (interface/override) is a whole-graph inference: a single-file
    // analyze can't see other files' implementers, so reconcileFile would drop this
    // file's cross-file dispatch edges. Re-derive them over the full store after the
    // structural change, restoring full-index parity. (ama-tr1)
    relinkTypes(store); // resolve baseline type:<Name> candidates whole-graph BEFORE dispatch (ama 0.4.0 S0)
    redispatch(store);
    relinkPrisma(store); // re-resolve prisma.<model> links whole-graph too (ama-kvv)
    relinkCalls(store); // re-resolve cross-file baseline call edges whole-graph (ama-bnj)
    relinkRouteTests(store); // re-resolve route→test links whole-graph (ama-f2c)
    relinkEnv(store); // re-resolve process.env → .env links whole-graph (#53)
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

function emptyUnresolvedMap(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function nullPrototypeUnresolved(
  input: Record<string, number> | undefined,
): Record<string, number> {
  const out = emptyUnresolvedMap();
  if (!input) return out;
  for (const [name, count] of Object.entries(input)) out[name] = count;
  return out;
}

function compactResolutionStats(stats: ResolutionStats): ResolutionStats {
  const unresolved = compactBreakdown(stats.unresolved, stats.unresolvedOther);
  const diagnostics = compactBreakdown(stats.diagnostics ?? {}, stats.diagnosticsOther);
  return {
    callsTotal: stats.callsTotal,
    callsResolved: stats.callsResolved,
    unresolved: unresolved.values,
    ...(unresolved.other > 0 ? { unresolvedOther: unresolved.other } : {}),
    ...(Object.keys(diagnostics.values).length > 0 ? { diagnostics: diagnostics.values } : {}),
    ...(diagnostics.other > 0 ? { diagnosticsOther: diagnostics.other } : {}),
  };
}

function compactBreakdown(
  input: Record<string, number>,
  existingOther = 0,
): { values: Record<string, number>; other: number } {
  const values = emptyUnresolvedMap();
  let other = existingOther;
  const entries = Object.entries(input)
    .filter(([, count]) => count > 0)
    .sort(([aName, aCount], [bName, bCount]) => bCount - aCount || aName.localeCompare(bName));
  for (const [index, [name, count]] of entries.entries()) {
    if (index < MAX_RESOLUTION_BREAKDOWN_ENTRIES) values[name] = count;
    else other += count;
  }
  return { values, other };
}

/**
 * An indexer wired with the analyzers Ama ships today. Pass a `createStore`
 * factory to persist into SQLite instead of the default in-memory store.
 */
export function createDefaultIndexer(createStore?: (root: string) => Store): Indexer {
  const registry = new AnalyzerRegistry();
  registry.register(new TypeScriptAnalyzer());
  registry.register(new BaselineAnalyzer(pythonSpec));
  registry.register(new BaselineAnalyzer(javascriptSpec));
  const javaDeep = new JavaDeepAnalyzer();
  if (javaDeep.isAvailable()) registry.register(javaDeep);
  registry.register(new BaselineAnalyzer(javaSpec));
  registry.register(new BaselineAnalyzer(csharpSpec));
  registry.register(new BaselineAnalyzer(goSpec));
  registry.register(new BaselineAnalyzer(rustSpec));
  registry.register(new BaselineAnalyzer(phpSpec));
  registry.register(new BaselineAnalyzer(cSpec));
  registry.register(new BaselineAnalyzer(cppSpec));
  registry.register(new BaselineAnalyzer(kotlinSpec));
  registry.register(new BaselineAnalyzer(swiftSpec));
  registry.register(new SfcAnalyzer("vue", [".vue"]));
  registry.register(new SfcAnalyzer("svelte", [".svelte"]));
  registry.register(new PrismaAnalyzer());
  registry.register(new JavaBytecodeAnalyzer()); // resolved Java hierarchy from compiled .class (#47)
  registry.register(new DotenvAnalyzer()); // .env keys as value-origin nodes (#53)
  return new Indexer(registry, createStore);
}

/**
 * Re-derive the whole-graph dispatch edges (interface/override fan-out) over the
 * full store, replacing the prior ones. A full index gets these from the analyzer's
 * per-batch pass, but a single-file reindex can't (it lacks other files' subtypes),
 * so we recompute them store-wide after every reindex — clearing the stale tagged
 * set and re-adding the fresh derivation keeps incremental sync at full-index
 * parity. (ama-tr1) */
function redispatch(store: Store): void {
  const nodes = [...store.allNodes()];
  const base = store.allEdges().filter((e) => e.provenance !== "dispatch");
  store.replaceEdgesByProvenance("dispatch", deriveDispatchEdges(nodes, base));
}

/**
 * Re-derive baseline type edges (a `type:<Name>` candidate on an Inherits/Implements/UsesType edge →
 * the Class/Interface/Enum it names) over the full store, replacing the prior ones — mirrors
 * {@link redispatch}. A single file's analyzer can't see other files' types, so resolution happens
 * here. Runs BEFORE {@link redispatch} because dispatch consumes the resolved hierarchy. (ama 0.4.0 S0) */
function relinkTypes(store: Store): void {
  const nodes = [...store.allNodes()];
  const base = store.allEdges().filter((e) => e.provenance !== "type");
  store.replaceEdgesByProvenance("type", deriveTypeEdges(nodes, base));
}

/**
 * Re-derive the cross-analyzer Prisma links (`prisma.<model>` usage → schema model node)
 * over the full store, replacing the prior ones — mirrors {@link redispatch}. The TS
 * analyzer's raw `prisma-ref` candidates and the PrismaAnalyzer's model nodes only meet
 * here, after every analyzer has run, so resolution can't happen in either batch. (ama-kvv) */
function relinkPrisma(store: Store): void {
  const nodes = [...store.allNodes()];
  const base = store.allEdges().filter((e) => e.provenance !== "prisma");
  store.replaceEdgesByProvenance("prisma", derivePrismaReferences(nodes, base));
}

/**
 * Re-derive cross-file baseline call edges (a `call:<name>` candidate → a function in an imported
 * file) over the full store, replacing the prior ones — mirrors {@link relinkPrisma}. A single
 * file's analyzer can't see other files' functions, so resolution happens here. (ama-bnj) */
function relinkCalls(store: Store): void {
  const nodes = [...store.allNodes()];
  const base = store.allEdges().filter((e) => e.provenance !== "call");
  store.replaceEdgesByProvenance("call", deriveCallEdges(nodes, base));
}

/** Re-derive FastAPI TestClient route→test links over the full store, replacing the prior ones —
 *  mirrors {@link relinkCalls}. A `client.get("/x")` test call and the Route node live in
 *  different files, so resolution happens here, after every analyzer has run. (ama-f2c) */
function relinkRouteTests(store: Store): void {
  const nodes = [...store.allNodes()];
  const base = store.allEdges().filter((e) => e.provenance !== "route-test");
  store.replaceEdgesByProvenance("route-test", deriveRouteTestEdges(nodes, base));
}

/** Re-derive `.env` value-provenance links (a `env:<KEY>` candidate from a code read of
 *  `process.env.KEY` → the `.env` Variable origin node) over the full store — mirrors
 *  {@link relinkPrisma}. The reader and the `.env` origin live in different files, so resolution
 *  happens here. (No-op until a read-detector emits `env:` candidates; the resolver is ready.) (#53) */
function relinkEnv(store: Store): void {
  const nodes = [...store.allNodes()];
  const base = store.allEdges().filter((e) => e.provenance !== "env");
  store.replaceEdgesByProvenance("env", deriveEnvReferences(nodes, base));
}

/** Fingerprint a file for staleness tracking: size, mtime, and content hash.
 *  Returns null when the file has vanished (gone between discovery and now — an
 *  editor's atomic save or temp file) so the caller can drop it instead of
 *  crashing the index. (ama-7r5) */
export function fingerprint(root: string, rel: string): FileMeta | null {
  const abs = path.resolve(root, rel);
  try {
    const stat = fs.statSync(abs);
    const hash = crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
    return { path: rel, size: stat.size, mtimeMs: stat.mtimeMs, hash };
  } catch {
    return null;
  }
}

/**
 * Whether a file differs from its recorded fingerprint. Size and mtime are the
 * cheap first check; the content hash is consulted only when they are
 * inconclusive (mtime can change without the bytes changing), so an unchanged
 * file is never re-hashed. A file that has vanished counts as stale, so the
 * caller reindexes it and its `existsSync` check reconciles the removal. (ama-7r5)
 */
export function isStale(root: string, rel: string, meta: FileMeta): boolean {
  const abs = path.resolve(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return true;
  }
  if (stat.size === meta.size && stat.mtimeMs === meta.mtimeMs) return false;
  try {
    const hash = crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
    return hash !== meta.hash;
  } catch {
    return true;
  }
}

/**
 * Repo-relative paths of every file under `root`, skipping ignored trees. Files over the
 * parse cap are left out; `onSkipLarge` is invoked with each so a caller can report them
 * instead of dropping them silently. (ama-j0y)
 */
function discoverFiles(root: string, onSkipLarge?: (rel: string) => void): string[] {
  const rootRules = loadIgnoreRules(root); // dotfiles + IGNORED_DIRS + the root .gitignore
  const out: string[] = [];
  const walk = (dir: string, dirRel: string, parent: IgnoreRules): void => {
    // A directory's own .gitignore augments the rules for its subtree, dir-relative
    // (the root's is already folded into `rootRules`). (ama-pyk)
    const rules = dirRel === "" ? parent : withNestedIgnore(dir, dirRel, parent);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      // Path-aware so anchored .gitignore patterns (/build, pkg/internal) match
      // root-relatively, not at any depth; covers dotfiles + names/globs too. (ama-yhu)
      if (isIgnoredPath(rel, rules)) continue;
      if (entry.isDirectory()) walk(abs, rel, rules);
      else if (entry.isFile()) {
        // Skip oversized files (minified bundles, data blobs) — the same cap the
        // watcher enforces, so the initial index and re-index agree. Report the skip
        // (never silently dropped, like the per-analyzer isolation) so a caller knows a
        // file was omitted. A vanished file is just skipped.
        let size: number;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_SIZE_BYTES) {
          onSkipLarge?.(rel);
          continue;
        }
        out.push(rel);
      }
    }
  };
  walk(root, "", rootRules);
  return out;
}
