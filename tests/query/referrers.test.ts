import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function node(over: Partial<GraphNode> & { id: string; name: string }): GraphNode {
  return { kind: "Function", file: "src/app.ts", qualifiedName: over.name, tier: "deep", ...over };
}

/**
 * `reader` references the Variable `MAX`; a Route references the `handler`. Both
 * are References edges, so findReferrers — the general "what points at this symbol"
 * — returns the reader for the variable and the route for the handler.
 */
function setup(): QueryService {
  const store = new InMemoryStore();
  store.addNode(node({ id: "src/app.ts#MAX", name: "MAX", kind: "Variable" }));
  store.addNode(node({ id: "src/app.ts#reader", name: "reader" }));
  store.addNode(node({ id: "route:GET /x", name: "GET /x", kind: "Route" }));
  store.addNode(node({ id: "src/app.ts#handler", name: "handler" }));
  store.addEdge({ from: "src/app.ts#reader", to: "src/app.ts#MAX", kind: "References" });
  store.addEdge({ from: "route:GET /x", to: "src/app.ts#handler", kind: "References" });
  return new QueryService(store, "/repo");
}

describe("QueryService.findReferrers (ama-pfm)", () => {
  it("returns the symbols that reference a variable", () => {
    expect(
      setup()
        .findReferrers("MAX")
        .map((n) => n.name),
    ).toEqual(["reader"]);
  });

  it("returns the routes that reference a handler (same traversal as findRoutes)", () => {
    const q = setup();
    expect(q.findReferrers("handler").map((n) => n.name)).toEqual(["GET /x"]);
    expect(q.findRoutes("handler").map((n) => n.name)).toEqual(["GET /x"]);
  });

  it("node() includes the referrers of a symbol", () => {
    expect(
      setup()
        .node("MAX")
        ?.referrers.map((n) => n.name),
    ).toEqual(["reader"]);
  });
});
