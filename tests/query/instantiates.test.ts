import { describe, expect, it } from "vitest";
import type { GraphNode, NodeKind } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function n(id: string, kind: NodeKind = "Function"): GraphNode {
  const name = id.split("#")[1] ?? id;
  return { id, kind, name, file: "a.ts", qualifiedName: name, tier: "deep" };
}

describe("find_callers separates construction via the edge kind (ama-hft.11)", () => {
  function setup(): QueryService {
    const store = new InMemoryStore();
    store.addNode(n("a.ts#Widget", "Class"));
    store.addNode(n("a.ts#make"));
    store.addNode(n("a.ts#helper"));
    store.addNode(n("a.ts#caller"));
    store.addEdge({ from: "a.ts#make", to: "a.ts#Widget", kind: "Instantiates" });
    store.addEdge({ from: "a.ts#caller", to: "a.ts#helper", kind: "Calls" });
    return new QueryService(store, "/repo");
  }

  it("find_callers includes an instantiator, labeled via Instantiates", () => {
    const callers = setup().findCallers("Widget");
    expect(callers[0]?.symbol.id).toBe("a.ts#make");
    expect(callers[0]?.via).toBe("Instantiates");
  });

  it("labels a plain call via Calls", () => {
    const callers = setup().findCallers("helper");
    expect(callers[0]?.via).toBe("Calls");
  });
});
