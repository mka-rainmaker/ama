import { describe, expect, it } from "vitest";
import type { GraphNode, NodeKind } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function node(name: string, kind: NodeKind): GraphNode {
  return {
    id: `a.ts#${name}`,
    kind,
    name,
    file: "a.ts",
    qualifiedName: name,
    tier: "deep",
    range: { startLine: 1, endLine: 1 },
  };
}

function svc(): QueryService {
  const store = new InMemoryStore();
  store.addNode(node("Foo", "Class"));
  store.addNode(node("bar", "Function"));
  return new QueryService(store, "/repo");
}

/**
 * searchSymbol falls back to allNodes() when there's no free text, for filters-only
 * queries (`kind:Class`). A *completely* empty query (no text, no filters) hit that
 * fallback too and returned arbitrary symbols — it should return nothing. (ama-k3d)
 */
describe("searchSymbol empty-query handling (ama-k3d)", () => {
  it("returns nothing for an empty or whitespace query", () => {
    expect(svc().searchSymbol("")).toEqual([]);
    expect(svc().searchSymbol("   ")).toEqual([]);
  });

  it("still honors a filters-only query (it has a filter)", () => {
    expect(
      svc()
        .searchSymbol("kind:Class")
        .map((n) => n.name),
    ).toEqual(["Foo"]);
  });

  it("still matches free text", () => {
    expect(
      svc()
        .searchSymbol("bar")
        .map((n) => n.name),
    ).toEqual(["bar"]);
  });
});
