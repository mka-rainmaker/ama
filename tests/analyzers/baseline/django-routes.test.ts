import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { pythonSpec } from "../../../src/analyzers/baseline/python.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/django-routes");

/**
 * Django routes live in `urls.py` as `path("users/<int:pk>/", view)` calls — method-agnostic
 * (the view handles all verbs), so they form `ANY /users/:pk/`. A different Python shape than
 * Flask/FastAPI decorators, so the Python spec detects both. (ama-a2r) */
describe("Django URL routing (urls.py) (ama-a2r)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(pythonSpec).analyze(root, ["urls.py"]);
  });

  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);

  it("detects path() URL patterns and normalizes <int:pk> params", () => {
    expect(route("ANY /users/")).toBeDefined();
    expect(route("ANY /users/:pk/")).toBeDefined();
    expect(route("ANY /health")).toBeDefined();
  });

  it("emits one route per path() call", () => {
    expect(result.nodes.filter((n) => n.kind === "Route")).toHaveLength(3);
  });
});
