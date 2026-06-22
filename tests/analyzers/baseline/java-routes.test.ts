import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { javaSpec } from "../../../src/analyzers/baseline/java.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import { symbolId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/java-routes");

/**
 * Spring routes are annotation-based: a class `@RequestMapping("/users")` prefixes each method's
 * `@GetMapping("/{id}")`/`@PostMapping` to form `GET /users/:id`, with the method as handler. (ama-a2r) */
describe("Java framework routing (Spring) (ama-a2r)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(javaSpec).analyze(root, ["UserController.java"]);
  });

  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);
  const links = (routeName: string, fn: string) =>
    result.edges.some(
      (e) =>
        e.kind === "References" &&
        e.from === symbolId({ file: "UserController.java", qualifiedName: routeName }) &&
        e.to === symbolId({ file: "UserController.java", qualifiedName: fn }),
    );

  it("composes @RequestMapping prefix + @GetMapping/@PostMapping with {id} params", () => {
    expect(route("GET /users")).toBeDefined();
    expect(route("GET /users/:id")).toBeDefined();
    expect(route("POST /users")).toBeDefined();
    expect(links("GET /users/:id", "UserController.get")).toBe(true);
  });

  it("emits one route per mapped method", () => {
    expect(result.nodes.filter((n) => n.kind === "Route")).toHaveLength(3);
  });
});
