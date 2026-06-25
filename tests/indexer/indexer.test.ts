import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { AnalyzerRegistry } from "../../src/analyzers/registry.js";
import type { AnalysisResult, Analyzer } from "../../src/analyzers/types.js";
import { Indexer, createDefaultIndexer } from "../../src/indexer/indexer.js";
import type { IndexStats } from "../../src/indexer/indexer.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/mini-repo");

describe("Indexer", () => {
  let store: Store;
  let stats: IndexStats;
  beforeAll(async () => {
    const result = await createDefaultIndexer().index(root);
    store = result.store;
    stats = result.stats;
  });

  it("discovers only the source files an analyzer handles (ignores readme.md)", () => {
    expect(stats.fileCount).toBe(2);
  });

  it("builds a File node per source file", () => {
    const files = [...store.allNodes()]
      .filter((n) => n.kind === "File")
      .map((n) => n.file)
      .sort();
    expect(files).toEqual(["app.ts", "math.ts"]);
  });

  it("reports per-language coverage with its tier", () => {
    expect(stats.languages).toEqual([{ language: "typescript", tier: "deep", files: 2 }]);
  });

  it("resolves calls across files (run -> add)", () => {
    const out = store.edgesFrom("app.ts#run", "Calls").map((e) => e.to);
    expect(out).toContain("math.ts#add");
  });

  it("exposes node and edge totals in stats", () => {
    expect(stats.nodeCount).toBe(store.nodeCount);
    expect(stats.edgeCount).toBe(store.edgeCount);
    expect(stats.nodeCount).toBeGreaterThanOrEqual(4); // 2 files + add + run
  });

  it("records a fingerprint (size, mtime, hash) for each indexed file", () => {
    const files = store.allFiles();
    expect(files.map((f) => f.path).sort()).toEqual(["app.ts", "math.ts"]);
    for (const f of files) {
      expect(f.size).toBeGreaterThan(0);
      expect(f.mtimeMs).toBeGreaterThan(0);
      expect(f.hash).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe("Indexer resolution stat honesty (#45)", () => {
  it("omits resolution for a baseline-only index — nothing measured, not a misleading '0 of 0'", async () => {
    const baselineRoot = path.resolve(here, "../fixtures/csharp-basic");
    const { stats } = await createDefaultIndexer().index(baselineRoot);
    expect(stats.languages.every((l) => l.tier === "baseline")).toBe(true);
    expect(stats.resolution).toBeUndefined();
  });

  it("keeps resolution for a deep index that actually measured it", async () => {
    const { stats } = await createDefaultIndexer().index(root);
    expect(stats.resolution?.callsTotal).toBeGreaterThan(0);
  });

  it("aggregates unresolved names that collide with Object.prototype", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-resolution-proto-"));
    try {
      fs.writeFileSync(path.join(dir, "sample.toy"), "valueOf();\n");
      const registry = new AnalyzerRegistry();
      registry.register(new ValueOfAnalyzer());
      const { stats } = await new Indexer(registry).index(dir);

      expect(stats.resolution?.unresolved.valueOf).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps public resolution histograms while preserving folded counts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-resolution-cap-"));
    try {
      fs.writeFileSync(path.join(dir, "sample.many"), "calls();\n");
      const registry = new AnalyzerRegistry();
      registry.register(new ManyUnresolvedAnalyzer());
      const { stats } = await new Indexer(registry).index(dir);

      expect(Object.keys(stats.resolution?.unresolved ?? {})).toHaveLength(100);
      expect(stats.resolution?.unresolved.name105).toBe(105);
      expect(stats.resolution?.unresolved.name1).toBeUndefined();
      expect(stats.resolution?.unresolvedOther).toBe(15);
      expect(Object.keys(stats.resolution?.diagnostics ?? {})).toHaveLength(100);
      expect(stats.resolution?.diagnosticsOther).toBe(15);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Indexer persistence (SQLite-backed)", () => {
  it("persists tier/coverage metadata that survives reopen", async () => {
    const file = path.join(
      os.tmpdir(),
      `ama-cov-${process.pid}-${Math.floor(performance.now())}.db`,
    );
    try {
      const { store } = await createDefaultIndexer(() => new SqliteStore(file)).index(root);
      (store as SqliteStore).close();

      const reopened = new SqliteStore(file);
      const raw = reopened.getMeta("ama:coverage");
      expect(raw).toBeDefined();
      const coverage = JSON.parse(raw ?? "{}");
      expect(coverage.fileCount).toBe(2);
      expect(coverage.languages).toEqual([{ language: "typescript", tier: "deep", files: 2 }]);
      reopened.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.rmSync(`${file}${suffix}`, { force: true });
      }
    }
  });
});

class ValueOfAnalyzer implements Analyzer {
  readonly language = "toy";
  readonly tier = "deep";
  readonly extensions = [".toy"];

  analyze(_root: string, files: string[]): AnalysisResult {
    return {
      nodes: files.map((file) => ({
        id: file,
        kind: "File",
        name: file,
        file,
        qualifiedName: file,
        tier: "deep",
      })),
      edges: [],
      resolution: {
        callsTotal: 1,
        callsResolved: 0,
        unresolved: { valueOf: 1 },
      },
    };
  }
}

class ManyUnresolvedAnalyzer implements Analyzer {
  readonly language = "many";
  readonly tier = "deep";
  readonly extensions = [".many"];

  analyze(_root: string, files: string[]): AnalysisResult {
    const unresolved: Record<string, number> = Object.create(null);
    const diagnostics: Record<string, number> = Object.create(null);
    for (let i = 1; i <= 105; i++) {
      unresolved[`name${i}`] = i;
      diagnostics[`reason${i}`] = i;
    }
    return {
      nodes: files.map((file) => ({
        id: file,
        kind: "File",
        name: file,
        file,
        qualifiedName: file,
        tier: "deep",
      })),
      edges: [],
      resolution: {
        callsTotal: 5565,
        callsResolved: 0,
        unresolved,
        diagnostics,
      },
    };
  }
}
