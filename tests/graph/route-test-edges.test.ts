import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { index } from "../../src/api.js";
import type { GraphEdge, GraphNode } from "../../src/graph/index.js";
import { ROUTE_REF_PREFIX, deriveRouteTestEdges, symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function node(
  over: Partial<GraphNode> & { id: string; kind: GraphNode["kind"]; name: string },
): GraphNode {
  return { file: "f", qualifiedName: over.name, tier: "baseline", ...over };
}

/**
 * A FastAPI test exercises a route via a TestClient (`client.get("/users/1")`), not a direct call.
 * deriveRouteTestEdges matches that concrete path+verb against the Route nodes (param-aware) and
 * links the test → route, so impact_analysis(handler) → route → test reaches it. (ama-f2c) */
describe("deriveRouteTestEdges — TestClient path → Route (ama-f2c)", () => {
  const testId = symbolId({ file: "test_x.py", qualifiedName: "test_get_user" });
  const userRoute = node({ id: "r1", kind: "Route", name: "GET /users/:id", file: "app.py" });
  const reportRoute = node({ id: "r2", kind: "Route", name: "POST /reports", file: "app.py" });

  it("matches a concrete path against a parameterized route", () => {
    const edges: GraphEdge[] = [
      {
        from: testId,
        to: `${ROUTE_REF_PREFIX}GET /users/1`,
        kind: "References",
        provenance: "call-ref",
      },
    ];
    expect(deriveRouteTestEdges([userRoute, reportRoute], edges)).toContainEqual({
      from: testId,
      to: "r1",
      kind: "References",
      provenance: "route-test",
    });
  });

  it("matches an exact (paramless) path and drops a no-match", () => {
    const edges: GraphEdge[] = [
      {
        from: testId,
        to: `${ROUTE_REF_PREFIX}POST /reports`,
        kind: "References",
        provenance: "call-ref",
      },
      {
        from: testId,
        to: `${ROUTE_REF_PREFIX}GET /nope`,
        kind: "References",
        provenance: "call-ref",
      },
    ];
    const out = deriveRouteTestEdges([userRoute, reportRoute], edges);
    expect(out).toContainEqual({
      from: testId,
      to: "r2",
      kind: "References",
      provenance: "route-test",
    });
    expect(out).toHaveLength(1); // /nope matched nothing
  });
});

describe("FastAPI route→handler→test end-to-end (ama-f2c)", () => {
  it("impact_analysis(handler) reaches the TestClient test through the route", async () => {
    const ama = await index(path.resolve(here, "../fixtures/py-route-test"));
    try {
      const impacted = ama.impactAnalysis("get_user").map((n) => n.name);
      expect(impacted).toContain("test_get_user"); // test → GET /users/:id → get_user
    } finally {
      ama.close();
    }
  });
});
