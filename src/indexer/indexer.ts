import * as fs from "node:fs";
import * as path from "node:path";
import { AnalyzerRegistry } from "../analyzers/registry.js";
import type { Analyzer } from "../analyzers/types.js";
import { TypeScriptAnalyzer } from "../analyzers/typescript/analyzer.js";
import type { Tier } from "../graph/index.js";
import { InMemoryStore } from "../store/memory.js";

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
  constructor(private readonly registry: AnalyzerRegistry) {}

  async index(root: string): Promise<{ store: InMemoryStore; stats: IndexStats }> {
    const store = new InMemoryStore();

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
      fileCount += files.length;
      languages.push({
        language: analyzer.language,
        tier: analyzer.tier,
        files: files.length,
      });
    }

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
}

/** An indexer wired with the analyzers Ama ships today. */
export function createDefaultIndexer(): Indexer {
  const registry = new AnalyzerRegistry();
  registry.register(new TypeScriptAnalyzer());
  return new Indexer(registry);
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
