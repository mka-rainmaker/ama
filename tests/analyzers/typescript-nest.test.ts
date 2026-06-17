import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-nest");
const id = (qualifiedName: string) => symbolId({ file: "users.controller.ts", qualifiedName });

describe("TypeScriptAnalyzer NestJS route detection", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["users.controller.ts"]);
  });

  it("composes @Controller prefix + @Get path into a Route node", () => {
    // @Controller("users") + @Get() → "GET /users"
    expect(result.nodes.find((n) => n.id === id("GET /users"))?.kind).toBe("Route");
    // @Controller("users") + @Post(":id") → "POST /users/:id"
    expect(result.nodes.find((n) => n.id === id("POST /users/:id"))?.kind).toBe("Route");
  });

  it("references the decorated method as the handler", () => {
    expect(
      result.edges.some(
        (e) =>
          e.kind === "References" &&
          e.from === id("GET /users") &&
          e.to === id("UsersController.findAll"),
      ),
    ).toBe(true);
    expect(
      result.edges.some(
        (e) =>
          e.kind === "References" &&
          e.from === id("POST /users/:id") &&
          e.to === id("UsersController.create"),
      ),
    ).toBe(true);
  });
});
