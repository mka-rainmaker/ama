import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { phpSpec } from "../../../src/analyzers/baseline/php.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/php-routes");

/**
 * Laravel registers routes via the `Route` facade: `Route::get('/users/{id}', ...)` forms
 * `GET /users/:id`. Scoped to the `Route` facade so `Cache::get(...)` etc. don't match. (ama-a2r) */
describe("PHP framework routing (Laravel) (ama-a2r)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(phpSpec).analyze(root, ["web.php"]);
  });

  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);

  it("detects Route::get/post and normalizes {id} params", () => {
    expect(route("GET /users")).toBeDefined();
    expect(route("GET /users/:id")).toBeDefined();
    expect(route("POST /users")).toBeDefined();
  });

  it("ignores non-Route static calls (e.g. Cache::get)", () => {
    expect(result.nodes.filter((n) => n.kind === "Route")).toHaveLength(3);
  });
});
