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

    it("dedupes identical (from, to, kind) edges", () => {
      const store = makeStore();
      // The same fact emitted twice (e.g. `greet()` and an aliased `lib.greet()`
      // resolving to one target) must collapse to a single edge.
      store.addEdge({ from: "a", to: "b", kind: "Calls" });
      store.addEdge({ from: "a", to: "b", kind: "Calls" });
      expect(store.edgeCount).toBe(1);
      expect(store.edgesFrom("a", "Calls")).toEqual([{ from: "a", to: "b", kind: "Calls" }]);
      expect(store.edgesTo("b", "Calls")).toEqual([{ from: "a", to: "b", kind: "Calls" }]);
      // A different kind to the same target is a distinct edge, not a duplicate.
      store.addEdge({ from: "a", to: "b", kind: "Imports" });
      expect(store.edgeCount).toBe(2);
      expect(store.edgesFrom("a")).toHaveLength(2);
    });

    it("round-trips an edge's call sites (ama-hft.10)", () => {
      const store = makeStore();
      const sites = [
        { line: 1, column: 2 },
        { line: 3, column: 4 },
      ];
      store.addEdge({ from: "a", to: "b", kind: "Calls", at: sites[0], sites });
      expect(store.edgesFrom("a", "Calls")[0]?.sites).toEqual(sites);
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

    it("matches by qualified name, not just the simple name", () => {
      const store = makeStore();
      store.addNode(node({ id: "cmd.ts#Cmd.run", name: "run", qualifiedName: "Cmd.run" }));
      store.addNode(
        node({ id: "other.ts#run", name: "run", qualifiedName: "run", file: "other.ts" }),
      );
      // A dotted ref resolves the specific member, not just anything named "run".
      expect(store.searchByName("Cmd.run").map((n) => n.id)).toContain("cmd.ts#Cmd.run");
      // The container name surfaces its members.
      expect(store.searchByName("Cmd").map((n) => n.id)).toContain("cmd.ts#Cmd.run");
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

    it("removeFile drops a file's nodes and the edges they own, keeping other files", () => {
      const store = makeStore();
      store.addNode(node({ id: "a#1", name: "one", file: "src/a.ts" }));
      store.addNode(node({ id: "a#2", name: "two", file: "src/a.ts" }));
      store.addNode(node({ id: "b#1", name: "three", file: "src/b.ts" }));
      store.addEdge({ from: "a#1", to: "a#2", kind: "Calls" }); // a owns (intra-file)
      store.addEdge({ from: "a#1", to: "b#1", kind: "Calls" }); // a owns, points into b
      store.addEdge({ from: "b#1", to: "a#1", kind: "Calls" }); // b owns, points into a
      store.recordFile({ path: "src/a.ts", size: 1, mtimeMs: 1, hash: "a" });
      store.recordFile({ path: "src/b.ts", size: 1, mtimeMs: 1, hash: "b" });

      store.removeFile("src/a.ts");

      // a's nodes are gone; b's remain.
      expect(store.getNode("a#1")).toBeUndefined();
      expect(store.getNode("a#2")).toBeUndefined();
      expect(store.getNode("b#1")).toBeDefined();
      expect([...store.allNodes()].map((n) => n.id)).toEqual(["b#1"]);
      expect(store.nodeCount).toBe(1);
      expect(store.nodesByName("one")).toEqual([]);

      // Edges a owned are gone; the edge b owns survives (even though it now
      // dangles into a removed node — that is the documented reconcile trade-off).
      expect(store.edgesFrom("a#1")).toEqual([]);
      expect(store.edgeCount).toBe(1);
      expect(store.edgesFrom("b#1", "Calls")).toEqual([{ from: "b#1", to: "a#1", kind: "Calls" }]);

      // a's fingerprint is gone; b's remains.
      expect(store.getFile("src/a.ts")).toBeUndefined();
      expect(store.getFile("src/b.ts")).toBeDefined();
    });

    it("removeFile is a no-op for a file with nothing indexed", () => {
      const store = makeStore();
      store.addNode(node({ id: "b#1", name: "three", file: "src/b.ts" }));
      store.removeFile("src/zzz.ts");
      expect(store.nodeCount).toBe(1);
      expect(store.getNode("b#1")).toBeDefined();
    });

    it("reconcileFile applies a minimal delta: upsert, add, drop, keep others", () => {
      const store = makeStore();
      store.addNode(node({ id: "a#foo", name: "foo", file: "a.ts" }));
      store.addNode(node({ id: "a#bar", name: "bar", file: "a.ts" }));
      store.addNode(node({ id: "b#main", name: "main", file: "b.ts" }));
      store.addEdge({ from: "a#foo", to: "a#bar", kind: "Calls" }); // owned, to be dropped
      store.addEdge({ from: "a#foo", to: "x#ext", kind: "Calls" }); // owned, unchanged
      store.addEdge({ from: "b#main", to: "a#foo", kind: "Calls" }); // inbound, must survive

      // New analysis of a.ts: bar removed, foo kept (range changed), baz added.
      const newFoo = node({
        id: "a#foo",
        name: "foo",
        file: "a.ts",
        range: { startLine: 9, endLine: 9 },
      });
      const newBaz = node({ id: "a#baz", name: "baz", file: "a.ts" });
      store.reconcileFile(
        "a.ts",
        [newFoo, newBaz],
        [
          { from: "a#foo", to: "x#ext", kind: "Calls" }, // unchanged owned edge
          { from: "a#baz", to: "a#foo", kind: "Calls" }, // new owned edge
        ],
      );

      // Nodes: bar dropped, baz added, foo upserted in place, b untouched.
      expect(store.getNode("a#bar")).toBeUndefined();
      expect(store.getNode("a#baz")).toBeDefined();
      expect(store.getNode("a#foo")?.range).toEqual({ startLine: 9, endLine: 9 });
      expect(store.getNode("b#main")).toBeDefined();
      // Upsert must not duplicate the by-name index entry.
      expect(store.nodesByName("foo")).toHaveLength(1);

      // Owned edges reconciled: foo->bar gone, foo->ext kept, baz->foo added.
      expect(store.edgesFrom("a#foo", "Calls").map((e) => e.to)).toEqual(["x#ext"]);
      expect(store.edgesFrom("a#baz", "Calls").map((e) => e.to)).toEqual(["a#foo"]);
      // The inbound edge owned by b survives the reconcile.
      expect(store.edgesTo("a#foo", "Calls").map((e) => e.from)).toContain("b#main");
    });

    it("reconcileFile adds a brand-new file's nodes and edges", () => {
      const store = makeStore();
      store.reconcileFile(
        "new.ts",
        [node({ id: "new#f", name: "f", file: "new.ts" })],
        [{ from: "new#f", to: "dep", kind: "Calls" }],
      );
      expect(store.getNode("new#f")).toBeDefined();
      expect(store.edgesFrom("new#f", "Calls").map((e) => e.to)).toEqual(["dep"]);
    });

    it("clear removes all nodes, edges, files, and metadata", () => {
      const store = makeStore();
      store.addNode(node({ id: "a#1", name: "one" }));
      store.addEdge({ from: "a#1", to: "x", kind: "Calls" });
      store.recordFile({ path: "a.ts", size: 1, mtimeMs: 1, hash: "h" });
      store.setMeta("k", "v");

      store.clear();

      expect(store.nodeCount).toBe(0);
      expect(store.edgeCount).toBe(0);
      expect([...store.allNodes()]).toEqual([]);
      expect(store.allFiles()).toEqual([]);
      expect(store.getNode("a#1")).toBeUndefined();
      expect(store.getMeta("k")).toBeUndefined();
      // Still usable after clearing.
      store.addNode(node({ id: "b#1", name: "two", file: "b.ts" }));
      expect(store.nodeCount).toBe(1);
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
