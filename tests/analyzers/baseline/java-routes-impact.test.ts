import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { symbolId } from "../../../src/graph/index.js";
import { createDefaultIndexer } from "../../../src/indexer/indexer.js";
import { QueryService } from "../../../src/query/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * End-to-end through the indexer + query layer: a JAX-RS handler reached only by framework dispatch
 * is still a live entry point. find_handlers/find_routes surface the Route+handler, and
 * impact_analysis(handler) reaches its Route (via the Route → References → handler edge reverse-walked
 * in IMPACT_EDGE_KINDS) — no fabricated Calls edge, no extra seeding needed. (ama 0.4.0 S4) */
describe("Java JAX-RS routes via the default indexer (ama 0.4.0 S4)", () => {
  const root = path.resolve(here, "../../fixtures/java-jaxrs");
  let query: QueryService;
  const file = "com/api/BookResource.java";
  beforeAll(async () => {
    const { store } = await createDefaultIndexer().index(root);
    query = new QueryService(store, root);
  });

  it("find_handlers returns the handler a route references", () => {
    expect(
      query
        .findHandlers("GET /books/:id")
        .map((n) => n.symbol.qualifiedName)
        .sort(),
    ).toEqual(["BookResource.get"]);
  });

  it("find_routes returns the route(s) referencing a handler", () => {
    const routes = query.findRoutes("BookResource.create");
    expect(routes.map((n) => n.symbol.name)).toEqual(["POST /books"]);
    expect(routes[0]?.symbol.kind).toBe("Route");
  });

  it("impact_analysis(handler) reaches the dispatching Route (handler is a live entry point)", () => {
    const routeId = symbolId({ file, qualifiedName: "DELETE /books/:id" });
    expect(query.impactAnalysis("BookResource.remove").map((n) => n.id)).toContain(routeId);
  });

  it("find_callers stays empty for a JAX-RS handler (framework dispatch is not a call)", () => {
    expect(query.findCallers("BookResource.list")).toEqual([]);
  });
});
