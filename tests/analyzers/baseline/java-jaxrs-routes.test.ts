import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { javaSpec } from "../../../src/analyzers/baseline/java.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import { symbolId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * JAX-RS is annotation-driven: a class `@Path("/books")` prefixes each method's `@Path` (or empty),
 * with the verb from a `@GET`/`@POST`/… marker. The route References its handler (`Class.method`) —
 * framework dispatch is modeled as a Route + References, NEVER a fabricated Calls edge. (ama 0.4.0 S4) */
describe("Java JAX-RS routing (ama 0.4.0 S4)", () => {
  const root = path.resolve(here, "../../fixtures/java-jaxrs");
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(javaSpec).analyze(root, ["com/api/BookResource.java"]);
  });

  const file = "com/api/BookResource.java";
  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);
  const links = (routeName: string, fn: string) =>
    result.edges.some(
      (e) =>
        e.kind === "References" &&
        e.from === symbolId({ file, qualifiedName: routeName }) &&
        e.to === symbolId({ file, qualifiedName: fn }),
    );

  it("composes class @Path prefix + method verb/@Path (with {id} → :id)", () => {
    expect(route("GET /books")).toBeDefined();
    expect(route("GET /books/:id")).toBeDefined();
    expect(route("POST /books")).toBeDefined();
    expect(route("DELETE /books/:id")).toBeDefined();
  });

  it("References each route to its handler method", () => {
    expect(links("GET /books", "BookResource.list")).toBe(true);
    expect(links("GET /books/:id", "BookResource.get")).toBe(true);
    expect(links("POST /books", "BookResource.create")).toBe(true);
    expect(links("DELETE /books/:id", "BookResource.remove")).toBe(true);
  });

  it("emits one route per annotated handler and NO fabricated Calls edge", () => {
    expect(result.nodes.filter((n) => n.kind === "Route")).toHaveLength(4);
    // Honesty: framework dispatch is a Route+References, never a Calls edge into a handler.
    const handlerIds = new Set(
      ["list", "get", "create", "remove"].map((m) =>
        symbolId({ file, qualifiedName: `BookResource.${m}` }),
      ),
    );
    expect(result.edges.some((e) => e.kind === "Calls" && handlerIds.has(e.to))).toBe(false);
  });
});

/**
 * Javalin is call-site: `app.get("/path", handler)` registers a route whose handler is the method
 * reference / lambda argument. A `App::health` method reference resolves to the `App.health` handler;
 * a bare lambda has no symbol and is left handler-less (Route still emitted). (ama 0.4.0 S4) */
describe("Java Javalin routing (ama 0.4.0 S4)", () => {
  const root = path.resolve(here, "../../fixtures/java-javalin");
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(javaSpec).analyze(root, ["com/web/App.java"]);
  });

  const file = "com/web/App.java";
  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);
  const links = (routeName: string, fn: string) =>
    result.edges.some(
      (e) =>
        e.kind === "References" &&
        e.from === symbolId({ file, qualifiedName: routeName }) &&
        e.to === symbolId({ file, qualifiedName: fn }),
    );

  it("detects app.get/post/put call sites with normalized {id} → :id paths", () => {
    expect(route("GET /health")).toBeDefined();
    expect(route("POST /items")).toBeDefined();
    expect(route("PUT /items/:id")).toBeDefined();
  });

  it("References a method-reference handler (App::health)", () => {
    expect(links("GET /health", "App.health")).toBe(true);
    expect(links("POST /items", "App.createItem")).toBe(true);
    expect(links("PUT /items/:id", "App.updateItem")).toBe(true);
  });
});
