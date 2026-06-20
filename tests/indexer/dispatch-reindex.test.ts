import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { symbolId } from "../../src/graph/index.js";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";
import type { Store } from "../../src/store/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-dispatch-reindex");

const useId = symbolId({ file: "caller.ts", qualifiedName: "use" });
const aRun = symbolId({ file: "impl-a.ts", qualifiedName: "A.run" });
const bRun = symbolId({ file: "impl-b.ts", qualifiedName: "B.run" });
const calls = (store: Store, from: string, to: string) =>
  store.edgesFrom(from).some((e) => e.to === to && e.kind === "Calls");

/**
 * Dispatch fan-out (a call through an interface reaches every implementer) is a
 * whole-graph derivation: `use(s: Svc) { s.run() }` in caller.ts gains Calls edges
 * to A.run and B.run because impl-a/impl-b (other files) `implements Svc`. A
 * single-file reindex of caller.ts can't see those implementers, so without a
 * store-level re-derivation reconcileFile drops the cross-file dispatch edges —
 * the incremental index silently loses edges a full index has. (ama-tr1)
 */
describe("dispatch edges survive a single-file reindex (ama-tr1)", () => {
  it("re-derives cross-file dispatch fan-out after reindexing the caller", async () => {
    const indexer = createDefaultIndexer();
    const { store } = await indexer.index(root);

    // A full index fans the interface call out to both implementations.
    expect(calls(store, useId, aRun)).toBe(true);
    expect(calls(store, useId, bRun)).toBe(true);

    // Reindexing the caller (unchanged) must not drop those cross-file edges.
    await indexer.reindexFile(store, root, "caller.ts");
    expect(calls(store, useId, aRun)).toBe(true);
    expect(calls(store, useId, bRun)).toBe(true);
  });
});
