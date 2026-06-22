import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { goSpec } from "../../../src/analyzers/baseline/go.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import { symbolId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/go-routes");

/**
 * Go web frameworks register routes by call, not decorator: `r.GET("/users/:id", getUser)`
 * (Gin/chi/echo) forms `GET /users/:id` with the handler arg as the handler. (ama-a2r) */
describe("Go framework routing (Gin/chi) (ama-a2r)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(goSpec).analyze(root, ["main.go"]);
  });

  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);
  const links = (routeName: string, fn: string) =>
    result.edges.some(
      (e) =>
        e.kind === "References" &&
        e.from === symbolId({ file: "main.go", qualifiedName: routeName }) &&
        e.to === symbolId({ file: "main.go", qualifiedName: fn }),
    );

  it("detects r.GET/r.POST registrations and Gin :id params", () => {
    expect(route("GET /users")).toBeDefined();
    expect(route("GET /users/:id")).toBeDefined();
    expect(route("POST /users")).toBeDefined();
    expect(links("GET /users", "listUsers")).toBe(true);
  });

  it("ignores non-route method calls (r.Run, gin.Default)", () => {
    expect(result.nodes.filter((n) => n.kind === "Route")).toHaveLength(3);
  });
});
