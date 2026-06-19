import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-rpc");
const id = (qualifiedName: string) => symbolId({ file: "api.ts", qualifiedName });

describe("TypeScriptAnalyzer RPC/schema-first route detection (ama-rme.11)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["api.ts"]);
  });

  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);
  const references = (routeName: string, handler: string) =>
    result.edges.some(
      (e) => e.kind === "References" && e.from === id(routeName) && e.to === id(handler),
    );

  it("detects a tRPC .query procedure and links its handler", () => {
    expect(route("query getUser")).toBeDefined();
    expect(references("query getUser", "getUser")).toBe(true);
  });

  it("detects a tRPC .mutation procedure with an inline handler", () => {
    expect(route("mutation createUser")).toBeDefined();
    expect(references("mutation createUser", "mutation createUser handler")).toBe(true);
  });

  it("detects GraphQL resolver-map fields (Type.field -> resolver)", () => {
    expect(route("Query.users")).toBeDefined();
    expect(references("Query.users", "listUsers")).toBe(true);
    expect(route("Mutation.deleteUser")).toBeDefined();
  });
});
