import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";
import type { IndexStats } from "../../src/indexer/indexer.js";
import type { InMemoryStore } from "../../src/store/memory.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/mini-repo");

describe("Indexer", () => {
  let store: InMemoryStore;
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
});
