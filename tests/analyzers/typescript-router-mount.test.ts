import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-express-router");
const id = (qualifiedName: string) => symbolId({ file: "app.ts", qualifiedName });

describe("TypeScriptAnalyzer Express Router mount-prefix composition", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["app.ts"]);
  });

  it("prepends the mount prefix to a router's route path", () => {
    // router.get("/users") + app.use("/api", router) → GET /api/users
    expect(result.nodes.find((n) => n.id === id("GET /api/users"))?.kind).toBe("Route");
    // and the un-prefixed path is NOT what we emit
    expect(result.nodes.some((n) => n.qualifiedName === "GET /users")).toBe(false);
  });

  it("still references the handler under the composed route", () => {
    expect(
      result.edges.some(
        (e) =>
          e.kind === "References" && e.from === id("GET /api/users") && e.to === id("listUsers"),
      ),
    ).toBe(true);
  });
});
