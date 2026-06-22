import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-filerouter-name");
const files = [
  "pages/api/users.ts",
  "src/pages/posts/[id].ts",
  "server/api/hello.ts",
  "pages/about.ts",
  // Next.js App Router (ama-vzq): page.tsx is the route for its directory.
  "app/page.tsx",
  "app/dashboard/page.tsx",
  "app/blog/[slug]/page.tsx",
  "app/(marketing)/pricing/page.tsx",
  "app/layout.tsx",
];

describe("TypeScriptAnalyzer filename-based routing (ama-w7g)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, files);
  });

  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);
  const referencesFrom = (routeName: string, file: string) =>
    result.edges.some(
      (e) => e.kind === "References" && e.from === symbolId({ file, qualifiedName: routeName }),
    );

  it("Next.js Pages Router: a default-export handler becomes an ALL route", () => {
    expect(route("ALL /api/users")).toBeDefined();
    expect(
      result.edges.some(
        (e) =>
          e.kind === "References" &&
          e.from === symbolId({ file: "pages/api/users.ts", qualifiedName: "ALL /api/users" }) &&
          e.to === symbolId({ file: "pages/api/users.ts", qualifiedName: "handler" }),
      ),
    ).toBe(true);
  });

  it("Astro: method exports under src/pages become per-method routes (filename + [id])", () => {
    expect(route("GET /posts/:id")).toBeDefined();
    expect(referencesFrom("GET /posts/:id", "src/pages/posts/[id].ts")).toBe(true);
  });

  it("Nuxt: a defineEventHandler default export becomes an ALL route", () => {
    expect(route("ALL /api/hello")).toBeDefined();
    expect(referencesFrom("ALL /api/hello", "server/api/hello.ts")).toBe(true);
  });

  it("does NOT route a non-api Next.js page (its default export is a component)", () => {
    expect(result.nodes.some((n) => n.kind === "Route" && n.qualifiedName.includes("/about"))).toBe(
      false,
    );
  });

  it("App Router: a page.tsx is the ALL route for its directory (ama-vzq)", () => {
    expect(route("ALL /dashboard")).toBeDefined();
    expect(referencesFrom("ALL /dashboard", "app/dashboard/page.tsx")).toBe(true);
  });

  it("App Router: the root app/page.tsx is the / route", () => {
    expect(route("ALL /")).toBeDefined();
    expect(referencesFrom("ALL /", "app/page.tsx")).toBe(true);
  });

  it("App Router: a [slug] segment becomes :slug", () => {
    expect(route("ALL /blog/:slug")).toBeDefined();
    expect(referencesFrom("ALL /blog/:slug", "app/blog/[slug]/page.tsx")).toBe(true);
  });

  it("App Router: a (group) directory is elided from the URL", () => {
    expect(route("ALL /pricing")).toBeDefined();
    expect(referencesFrom("ALL /pricing", "app/(marketing)/pricing/page.tsx")).toBe(true);
  });

  it("App Router: layout.tsx (not page/route) is NOT a route", () => {
    expect(result.nodes.some((n) => n.kind === "Route" && n.file === "app/layout.tsx")).toBe(false);
  });
});
