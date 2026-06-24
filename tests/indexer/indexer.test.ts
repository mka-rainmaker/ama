import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";
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
    const javaRoot = path.resolve(here, "../fixtures/java-hierarchy");
    const { stats } = await createDefaultIndexer().index(javaRoot);
    expect(stats.languages.every((l) => l.tier === "baseline")).toBe(true);
    expect(stats.resolution).toBeUndefined();
  });

  it("keeps resolution for a deep index that actually measured it", async () => {
    const { stats } = await createDefaultIndexer().index(root);
    expect(stats.resolution?.callsTotal).toBeGreaterThan(0);
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
