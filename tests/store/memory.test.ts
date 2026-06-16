import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { InMemoryStore } from "../../src/store/memory.js";

function node(over: Partial<GraphNode> & { id: string; name: string }): GraphNode {
  return {
    kind: "Function",
    file: "src/a.ts",
    qualifiedName: over.name,
    tier: "deep",
    ...over,
  };
}

describe("InMemoryStore", () => {
  it("stores and retrieves a node by id", () => {
    const s = new InMemoryStore();
    const n = node({ id: "src/a.ts#foo", name: "foo" });
    s.addNode(n);
    expect(s.getNode("src/a.ts#foo")).toEqual(n);
  });

  it("returns undefined for an unknown id", () => {
    const s = new InMemoryStore();
    expect(s.getNode("nope")).toBeUndefined();
  });

  it("indexes nodes by simple name", () => {
    const s = new InMemoryStore();
    const a = node({ id: "src/a.ts#foo", name: "foo" });
    const b = node({ id: "src/b.ts#foo", name: "foo", file: "src/b.ts" });
    s.addNode(a);
    s.addNode(b);
    expect(s.nodesByName("foo")).toEqual([a, b]);
    expect(s.nodesByName("missing")).toEqual([]);
  });

  it("returns outgoing edges, optionally filtered by kind", () => {
    const s = new InMemoryStore();
    s.addEdge({ from: "a", to: "b", kind: "Calls" });
    s.addEdge({ from: "a", to: "c", kind: "Imports" });
    expect(s.edgesFrom("a")).toHaveLength(2);
    expect(s.edgesFrom("a", "Calls")).toEqual([{ from: "a", to: "b", kind: "Calls" }]);
  });

  it("returns incoming edges, optionally filtered by kind", () => {
    const s = new InMemoryStore();
    s.addEdge({ from: "x", to: "target", kind: "Calls" });
    s.addEdge({ from: "y", to: "target", kind: "Calls" });
    expect(s.edgesTo("target", "Calls").map((e) => e.from)).toEqual(["x", "y"]);
  });

  it("tracks node and edge counts", () => {
    const s = new InMemoryStore();
    s.addNode(node({ id: "n1", name: "n1" }));
    s.addEdge({ from: "n1", to: "n2", kind: "Calls" });
    expect(s.nodeCount).toBe(1);
    expect(s.edgeCount).toBe(1);
  });
});
