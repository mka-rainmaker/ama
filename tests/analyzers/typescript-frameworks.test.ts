import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-frameworks");
const id = (qualifiedName: string) => symbolId({ file: "app.ts", qualifiedName });

describe("TypeScriptAnalyzer object-config route detection (ama-rme.10)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["app.ts"]);
  });

  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);
  const handles = (routeName: string) =>
    result.edges.some(
      (e) => e.kind === "References" && e.from === id(routeName) && e.to === id("getUsers"),
    );

  it("detects a Hapi object-config route (method + path + handler)", () => {
    expect(route("GET /hapi/users")).toBeDefined();
    expect(handles("GET /hapi/users")).toBe(true);
  });

  it("detects a Fastify object-config route (method + url + handler)", () => {
    expect(route("POST /fastify/users")).toBeDefined();
    expect(handles("POST /fastify/users")).toBe(true);
  });

  it("still detects method-named routing (Fastify/Koa/Hono via the Express path)", () => {
    expect(route("GET /fastify/health")).toBeDefined();
    expect(handles("GET /fastify/health")).toBe(true);
  });
});
