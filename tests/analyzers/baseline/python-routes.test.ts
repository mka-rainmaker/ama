import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { pythonSpec } from "../../../src/analyzers/baseline/python.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import { symbolId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/py-routes");

/**
 * Route detection in the baseline (tree-sitter) tier — Flask/FastAPI decorators: `@app.route`
 * is GET, `@app.get/.post/...` take the verb from the attribute; Flask `<id>`/`<int:id>` and
 * FastAPI `{id}` normalize to `:id`. The decorated function is the handler. (ama-bvg) */
describe("Python framework routing (Flask/FastAPI) (ama-bvg)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(pythonSpec).analyze(root, ["app.py"]);
  });

  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);
  const links = (routeName: string, fn: string) =>
    result.edges.some(
      (e) =>
        e.kind === "References" &&
        e.from === symbolId({ file: "app.py", qualifiedName: routeName }) &&
        e.to === symbolId({ file: "app.py", qualifiedName: fn }),
    );

  it("detects @app.route (default GET) and normalizes Flask path params", () => {
    expect(route("GET /users")).toBeDefined();
    expect(route("GET /users/:id")).toBeDefined();
    expect(links("GET /users", "list_users")).toBe(true);
  });

  it("detects method decorators and normalizes FastAPI {param}", () => {
    expect(route("GET /health")).toBeDefined();
    expect(route("POST /items/:item_id")).toBeDefined();
    expect(links("POST /items/:item_id", "create_item")).toBe(true);
  });

  it("ignores undecorated functions", () => {
    expect(result.nodes.filter((n) => n.kind === "Route")).toHaveLength(4);
  });
});
