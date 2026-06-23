import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { javaSpec } from "../../../src/analyzers/baseline/java.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import { symbolId } from "../../../src/graph/index.js";
import { createDefaultIndexer } from "../../../src/indexer/indexer.js";
import { QueryService } from "../../../src/query/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Honesty gate (0.4.0 review): the Javalin verb method names (`get`/`put`/`post`/…) collide with
 * ubiquitous stdlib calls (`map.get("k")`, `cache.put("k", v)`, `Optional.get()`). Matching name + a
 * string first arg alone would fabricate phantom Route nodes that pollute find_routes/find_handlers
 * and seed impact_analysis with bogus entry points. The detector must emit ZERO routes here. (ama 0.4.0 S4) */
describe("Java Javalin routing rejects stdlib verb-name collisions (ama 0.4.0 S4)", () => {
  const root = path.resolve(here, "../../fixtures/java-javalin-negative");
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(javaSpec).analyze(root, ["com/web/StdlibCalls.java"]);
  });

  it("emits no Route node for map.get / cache.put / Optional.get", () => {
    expect(result.nodes.filter((n) => n.kind === "Route")).toEqual([]);
  });
});

/**
 * Handler qn for a route must be the method's full dotted chain (the #34 lesson): for a nested
 * `@RestController` (`Outer.Inner.list`) the Route → References → handler edge must target
 * `Outer.Inner.list`, not the simple-class `Inner.list`, or the edge dangles and the handler silently
 * stops being a reachable entry point. (ama 0.4.0 S4) */
describe("Java nested-controller route resolves to the full dotted handler (ama 0.4.0 S4)", () => {
  const root = path.resolve(here, "../../fixtures/java-nested-routes");
  const file = "com/api/Outer.java";
  let query: QueryService;
  beforeAll(async () => {
    const { store } = await createDefaultIndexer().index(root);
    query = new QueryService(store, root);
  });

  it("References the nested handler by its full dotted qn (Outer.Inner.list)", () => {
    expect(
      query
        .findHandlers("GET /api/books")
        .map((n) => n.symbol.qualifiedName)
        .sort(),
    ).toEqual(["Outer.Inner.list"]);
  });

  it("find_routes(Outer.Inner.list) returns the route (handler is reachable)", () => {
    const routes = query.findRoutes("Outer.Inner.list");
    expect(routes.map((n) => n.symbol.name)).toEqual(["GET /api/books"]);
  });

  it("impact_analysis(Outer.Inner.list) reaches the dispatching Route (live entry point)", () => {
    const routeId = symbolId({ file, qualifiedName: "GET /api/books" });
    expect(query.impactAnalysis("Outer.Inner.list").map((n) => n.id)).toContain(routeId);
  });
});
