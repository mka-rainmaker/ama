import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { javaSpec } from "../../../src/analyzers/baseline/java.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import { symbolId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression suite for two `annotationArg` correctness bugs (ama 0.4.0 adversarial review #41):
 *
 * (a) Named-arg out-of-order: `@GetMapping(produces="application/json", value="/s")` — the old
 *     first-string-fragment approach would return "application/json" as the route path instead of
 *     the value= string.  The fix prefers the `value=` / `path=` named pair and ignores others.
 *
 * (b) FQN annotations: `@org.springframework.web.bind.annotation.GetMapping("/fqn")` — the old
 *     `childForFieldName("name")?.text` returned the full scoped text, which never matched the
 *     simple-name keys in JAVA_MAPPING_VERBS. The fix strips to the last dotted segment. */
describe("Java Spring annotation arg correctness: named-arg order + FQN (ama 0.4.0 #41)", () => {
  const root = path.resolve(here, "../../fixtures/java-routes-ann");
  const file = "com/web/ShopController.java";
  let result: AnalysisResult;

  beforeAll(async () => {
    result = await new BaselineAnalyzer(javaSpec).analyze(root, [file]);
  });

  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);

  const links = (routeName: string, handlerQn: string) =>
    result.edges.some(
      (e) =>
        e.kind === "References" &&
        e.from === symbolId({ file, qualifiedName: routeName }) &&
        e.to === symbolId({ file, qualifiedName: handlerQn }),
    );

  it("(a) @GetMapping with produces=… FIRST, value= SECOND → uses value path, not produces value", () => {
    // Bug: old code returned "application/json" as the route path.
    expect(route("GET /shop/search")).toBeDefined();
    // Must NOT emit a bogus "application/json" route
    expect(route("GET /shop/application/json")).toBeUndefined();
  });

  it("(a) @PostMapping with produces=… FIRST, path= SECOND → uses path, not produces", () => {
    expect(route("POST /shop/orders")).toBeDefined();
    expect(route("POST /shop/application/json")).toBeUndefined();
  });

  it("(b) FQN @org.springframework…GetMapping('/fqn') is detected as a Spring route", () => {
    // Bug: old code compared the full scoped_identifier text against "GetMapping" — never matched.
    expect(route("GET /shop/fqn")).toBeDefined();
  });

  it("positional @GetMapping('/simple') still works after the fix", () => {
    expect(route("GET /shop/simple")).toBeDefined();
  });

  it("References each route to its handler method", () => {
    expect(links("GET /shop/search", "ShopController.search")).toBe(true);
    expect(links("POST /shop/orders", "ShopController.placeOrder")).toBe(true);
    expect(links("GET /shop/fqn", "ShopController.fqnRoute")).toBe(true);
    expect(links("GET /shop/simple", "ShopController.simple")).toBe(true);
  });

  it("emits exactly 4 routes (search, orders, fqn, simple) — no phantom routes", () => {
    expect(result.nodes.filter((n) => n.kind === "Route")).toHaveLength(4);
  });
});
