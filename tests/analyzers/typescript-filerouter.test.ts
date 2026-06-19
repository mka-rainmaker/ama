import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-filerouter");
const files = ["app/api/users/route.ts", "app/posts/[id]/route.ts", "src/routes/health/+server.ts"];

describe("TypeScriptAnalyzer file-based routing (ama-rme.7)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, files);
  });

  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);
  const referencesHandlerIn = (routeName: string, file: string) =>
    result.edges.some(
      (e) =>
        e.kind === "References" &&
        e.from === symbolId({ file, qualifiedName: routeName }) &&
        e.to === symbolId({ file, qualifiedName: routeName.split(" ")[0] ?? "" }),
    );

  it("derives a Next.js App Router route from the file path and exported methods", () => {
    expect(route("GET /api/users")).toBeDefined();
    expect(route("POST /api/users")).toBeDefined();
    expect(referencesHandlerIn("GET /api/users", "app/api/users/route.ts")).toBe(true);
  });

  it("converts a [id] dynamic segment to :id", () => {
    expect(route("GET /posts/:id")).toBeDefined();
  });

  it("detects a SvelteKit +server.ts endpoint under src/routes", () => {
    expect(route("GET /health")).toBeDefined();
    expect(referencesHandlerIn("GET /health", "src/routes/health/+server.ts")).toBe(true);
  });
});
