import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function method(container: string, name: string): GraphNode {
  return {
    id: `a.ts#${container}.${name}`,
    kind: "Method",
    name,
    file: "a.ts",
    qualifiedName: `${container}.${name}`,
    tier: "deep",
  };
}

function setup(): QueryService {
  const store = new InMemoryStore();
  store.addNode(method("Sub", "run"));
  store.addNode(method("Super", "run"));
  store.addEdge({ from: "a.ts#Sub.run", to: "a.ts#Super.run", kind: "Overrides" });
  return new QueryService(store, "/repo");
}

describe("Overrides queries (ama-38n)", () => {
  it("findOverrides returns what a method overrides (outgoing)", () => {
    expect(setup().findOverrides("Sub.run").map((n) => n.symbol.id)).toEqual(["a.ts#Super.run"]);
  });

  it("findOverriddenBy returns what overrides a method (incoming)", () => {
    expect(setup().findOverriddenBy("Super.run").map((n) => n.symbol.id)).toEqual(["a.ts#Sub.run"]);
  });
});
