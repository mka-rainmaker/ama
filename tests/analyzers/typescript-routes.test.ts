import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-express");
const id = (qualifiedName: string) => symbolId({ file: "app.ts", qualifiedName });

describe("TypeScriptAnalyzer Express route detection", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["app.ts"]);
  });

  it("emits a Route node for each app.METHOD(path, handler) call", () => {
    expect(result.nodes.find((n) => n.id === id("GET /users"))?.kind).toBe("Route");
    expect(result.nodes.find((n) => n.id === id("POST /users"))?.kind).toBe("Route");
  });

  it("links a named handler to its route with a References edge", () => {
    expect(
      result.edges.some(
        (e) => e.kind === "References" && e.from === id("GET /users") && e.to === id("listUsers"),
      ),
    ).toBe(true);
  });

  it("does not invent a route for a non-route .get() call (needs a path + handler)", () => {
    // sanity: only the two real routes are Route nodes
    expect(result.nodes.filter((n) => n.kind === "Route")).toHaveLength(2);
  });
});
