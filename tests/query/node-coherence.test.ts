import { describe, expect, it } from "vitest";
import type { GraphNode, NodeKind } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function n(id: string, name: string, kind: NodeKind, file: string): GraphNode {
  return {
    id,
    kind,
    name,
    file,
    qualifiedName: name,
    tier: "deep",
    range: { startLine: 1, endLine: 1 },
  };
}

/**
 * Two methods named `foo` in different containers, each calling a different helper.
 * node("foo") picks one as its primary node — its callers/callees/etc. must describe
 * THAT node, not the union across every same-named symbol. (ama-d5o)
 */
function svc(): QueryService {
  const s = new InMemoryStore();
  s.addNode(n("a.ts#I", "I", "Interface", "a.ts"));
  s.addNode(n("a.ts#I.foo", "foo", "Method", "a.ts"));
  s.addNode(n("a.ts#helperA", "helperA", "Function", "a.ts"));
  s.addNode(n("b.ts#C", "C", "Class", "b.ts"));
  s.addNode(n("b.ts#C.foo", "foo", "Method", "b.ts"));
  s.addNode(n("b.ts#helperB", "helperB", "Function", "b.ts"));
  s.addEdge({ from: "a.ts#I", to: "a.ts#I.foo", kind: "Defines", provenance: "resolved" });
  s.addEdge({ from: "a.ts#I.foo", to: "a.ts#helperA", kind: "Calls", provenance: "resolved" });
  s.addEdge({ from: "b.ts#C", to: "b.ts#C.foo", kind: "Defines", provenance: "resolved" });
  s.addEdge({ from: "b.ts#C.foo", to: "b.ts#helperB", kind: "Calls", provenance: "resolved" });
  return new QueryService(s, "/repo");
}

describe("node() coherence for an ambiguous ref (ama-d5o)", () => {
  it("reports the primary node's own callees, not the union across same-named symbols", () => {
    const q = svc();
    const view = q.node("foo");
    if (!view) throw new Error("expected a node");
    // The raw-ref aggregate spans both foo methods (two distinct callees)...
    expect(q.findCallees("foo").length).toBe(2);
    // ...but the view must describe only its own primary node.
    expect(view.callees.length).toBe(1);
    expect(view.callees.map((c) => c.name)).toEqual(
      q.findCallees(view.node.id).map((c) => c.symbol.name),
    );
  });

  it("surfaces the other same-named symbols as alternatives (ama-ceh)", () => {
    const q = svc();
    const view = q.node("foo");
    if (!view) throw new Error("expected a node");
    // Two `foo` methods exist; one is primary, the other is an alternative.
    expect(view.alternatives.length).toBe(1);
    const ids = [view.node.id, ...view.alternatives.map((a) => a.id)].sort();
    expect(ids).toEqual(["a.ts#I.foo", "b.ts#C.foo"]);
  });

  it("has no alternatives for a unique ref", () => {
    const q = svc();
    const view = q.node("helperA");
    if (!view) throw new Error("expected a node");
    expect(view.alternatives).toEqual([]);
  });
});
