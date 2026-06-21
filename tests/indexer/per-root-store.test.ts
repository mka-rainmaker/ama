import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";
import { InMemoryStore } from "../../src/store/memory.js";
import type { Store } from "../../src/store/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projA = path.resolve(here, "../fixtures/xproj-a");
const projB = path.resolve(here, "../fixtures/xproj-b");

/**
 * A multi-project session holds one store per project, so index() must pass the root to
 * the store factory. A factory that ignored it (keying off a fixed db) would hand every
 * project the same store, aliasing them all onto the last index. (ama-mnj)
 */
describe("index() gives each root its own store (ama-mnj)", () => {
  it("passes the resolved root to the store factory, so projects stay independent", async () => {
    const byRoot = new Map<string, Store>();
    const indexer = createDefaultIndexer((root) => {
      const store = byRoot.get(root) ?? new InMemoryStore();
      byRoot.set(root, store);
      return store;
    });
    const a = await indexer.index(projA);
    const b = await indexer.index(projB);
    // Two distinct roots → two distinct stores, each holding its own project.
    expect(byRoot.size).toBe(2);
    expect(a.store).not.toBe(b.store);
    expect(a.store.nodeCount).toBeGreaterThan(0);
    expect(b.store.nodeCount).toBeGreaterThan(0);
  });
});
