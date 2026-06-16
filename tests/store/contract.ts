import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import type { Store } from "../../src/store/types.js";

function node(over: Partial<GraphNode> & { id: string; name: string }): GraphNode {
  return {
    kind: "Function",
    file: "src/a.ts",
    qualifiedName: over.name,
    tier: "deep",
    ...over,
  };
}

/**
 * Behavioural contract every {@link Store} implementation must satisfy. Run it
 * against each backend so the in-memory and SQLite stores stay at parity.
 */
export function runStoreContract(label: string, makeStore: () => Store): void {
  describe(`Store contract: ${label}`, () => {
    it("stores and retrieves a node by id", () => {
      const store = makeStore();
      const n = node({ id: "src/a.ts#foo", name: "foo" });
      store.addNode(n);
      expect(store.getNode("src/a.ts#foo")).toEqual(n);
    });

    it("returns undefined for an unknown id", () => {
      expect(makeStore().getNode("nope")).toBeUndefined();
    });

    it("indexes nodes by simple name", () => {
      const store = makeStore();
      const a = node({ id: "src/a.ts#foo", name: "foo" });
      const b = node({ id: "src/b.ts#foo", name: "foo", file: "src/b.ts" });
      store.addNode(a);
      store.addNode(b);
      expect(store.nodesByName("foo")).toEqual([a, b]);
      expect(store.nodesByName("missing")).toEqual([]);
    });

    it("returns outgoing edges, optionally filtered by kind", () => {
      const store = makeStore();
      store.addEdge({ from: "a", to: "b", kind: "Calls" });
      store.addEdge({ from: "a", to: "c", kind: "Imports" });
      expect(store.edgesFrom("a")).toHaveLength(2);
      expect(store.edgesFrom("a", "Calls")).toEqual([{ from: "a", to: "b", kind: "Calls" }]);
    });

    it("returns incoming edges, optionally filtered by kind", () => {
      const store = makeStore();
      store.addEdge({ from: "x", to: "target", kind: "Calls" });
      store.addEdge({ from: "y", to: "target", kind: "Calls" });
      expect(store.edgesTo("target", "Calls").map((e) => e.from)).toEqual(["x", "y"]);
    });

    it("iterates every node and tracks counts", () => {
      const store = makeStore();
      store.addNode(node({ id: "n1", name: "n1" }));
      store.addEdge({ from: "n1", to: "n2", kind: "Calls" });
      expect([...store.allNodes()].map((n) => n.id)).toEqual(["n1"]);
      expect(store.nodeCount).toBe(1);
      expect(store.edgeCount).toBe(1);
    });

    it("searches symbols by name prefix", () => {
      const store = makeStore();
      store.addNode(node({ id: "a#compute", name: "compute" }));
      store.addNode(node({ id: "b#computed", name: "computed", file: "b.ts" }));
      store.addNode(node({ id: "c#helper", name: "helper", file: "c.ts" }));
      const names = store
        .searchByName("comp")
        .map((n) => n.name)
        .sort();
      expect(names).toEqual(["compute", "computed"]);
    });

    it("matches names case-insensitively", () => {
      const store = makeStore();
      store.addNode(node({ id: "a#X", name: "TypeScriptAnalyzer" }));
      expect(store.searchByName("typescript").map((n) => n.name)).toEqual(["TypeScriptAnalyzer"]);
    });

    it("returns nothing for a non-matching query", () => {
      const store = makeStore();
      store.addNode(node({ id: "a#foo", name: "foo" }));
      expect(store.searchByName("zzz")).toEqual([]);
    });

    it("records and retrieves per-file metadata", () => {
      const store = makeStore();
      const meta = { path: "src/a.ts", size: 100, mtimeMs: 123.5, hash: "abc" };
      store.recordFile(meta);
      expect(store.getFile("src/a.ts")).toEqual(meta);
      expect(store.getFile("missing")).toBeUndefined();
    });

    it("replaces metadata when a file is re-recorded", () => {
      const store = makeStore();
      store.recordFile({ path: "a", size: 1, mtimeMs: 1, hash: "x" });
      store.recordFile({ path: "a", size: 2, mtimeMs: 2, hash: "y" });
      expect(store.getFile("a")).toEqual({
        path: "a",
        size: 2,
        mtimeMs: 2,
        hash: "y",
      });
      expect(store.allFiles()).toHaveLength(1);
    });

    it("persists arbitrary key/value metadata", () => {
      const store = makeStore();
      expect(store.getMeta("coverage")).toBeUndefined();
      store.setMeta("coverage", "v1");
      expect(store.getMeta("coverage")).toBe("v1");
      store.setMeta("coverage", "v2");
      expect(store.getMeta("coverage")).toBe("v2");
    });
  });
}
