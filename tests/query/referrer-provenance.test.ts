import { describe, expect, it } from "vitest";
import type { GraphNode, NodeKind } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function n(id: string, kind: NodeKind = "Function"): GraphNode {
  const name = id.split("#")[1] ?? id;
  return { id, kind, name, file: "a.ts", qualifiedName: name, tier: "deep" };
}

function setup(): QueryService {
  const store = new InMemoryStore();
  store.addNode(n("route:GET /x", "Route"));
  store.addNode(n("a.ts#handler"));
  store.addNode(n("a.ts#MAX", "Variable"));
  store.addNode(n("a.ts#reader"));
  // A heuristic route->handler reference, and a checker-resolved variable read.
  store.addEdge({
    from: "route:GET /x",
    to: "a.ts#handler",
    kind: "References",
    provenance: "heuristic",
  });
  store.addEdge({ from: "a.ts#reader", to: "a.ts#MAX", kind: "References" });
  return new QueryService(store, "/repo");
}

describe("edge provenance in route/referrer queries (ama-4ky)", () => {
  it("marks a route->handler reference heuristic in find_handlers", () => {
    const handlers = setup().findHandlers("route:GET /x");
    expect(handlers[0]?.symbol.id).toBe("a.ts#handler");
    expect(handlers[0]?.provenance).toBe("heuristic");
  });

  it("marks the route heuristic in find_routes (incoming References)", () => {
    const routes = setup().findRoutes("handler");
    expect(routes[0]?.symbol.id).toBe("route:GET /x");
    expect(routes[0]?.provenance).toBe("heuristic");
  });

  it("leaves a checker-resolved variable read unmarked in find_referrers", () => {
    const refs = setup().findReferrers("MAX");
    expect(refs[0]?.symbol.id).toBe("a.ts#reader");
    expect(refs[0]?.provenance).toBeUndefined();
  });
});
