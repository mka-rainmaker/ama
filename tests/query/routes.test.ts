import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function node(over: Partial<GraphNode> & { id: string; name: string }): GraphNode {
  return { kind: "Function", file: "src/app.ts", qualifiedName: over.name, tier: "deep", ...over };
}

/** A handler function and a Route node that References it (the rme.1 model). */
function setup(): QueryService {
  const store = new InMemoryStore();
  store.addNode(node({ id: "src/app.ts#getUsers", name: "getUsers" }));
  store.addNode(node({ id: "route:GET /users", name: "GET /users", kind: "Route" }));
  store.addEdge({ from: "route:GET /users", to: "src/app.ts#getUsers", kind: "References" });
  return new QueryService(store, "/repo");
}

describe("Route / References model", () => {
  it("finds the handlers a route references", () => {
    expect(setup().findHandlers("GET /users").map((n) => n.name)).toEqual(["getUsers"]);
  });

  it("finds the routes that reference a handler", () => {
    const routes = setup().findRoutes("getUsers");
    expect(routes.map((n) => n.name)).toEqual(["GET /users"]);
    expect(routes[0]?.kind).toBe("Route");
  });
});
