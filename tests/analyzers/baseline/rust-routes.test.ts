import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { rustSpec } from "../../../src/analyzers/baseline/rust.js";
import type { AnalysisResult } from "../../../src/analyzers/types.js";
import { symbolId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/rust-routes");

/**
 * actix-web routes are attribute macros on functions: `#[get("/users/{id}")]` above `fn get_user`
 * forms `GET /users/:id`, with the function as handler. (ama-a2r) */
describe("Rust framework routing (actix) (ama-a2r)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new BaselineAnalyzer(rustSpec).analyze(root, ["main.rs"]);
  });

  const route = (name: string) =>
    result.nodes.find((n) => n.kind === "Route" && n.qualifiedName === name);
  const links = (routeName: string, fn: string) =>
    result.edges.some(
      (e) =>
        e.kind === "References" &&
        e.from === symbolId({ file: "main.rs", qualifiedName: routeName }) &&
        e.to === symbolId({ file: "main.rs", qualifiedName: fn }),
    );

  it("detects #[get]/#[post] attribute routes and normalizes {id}", () => {
    expect(route("GET /users")).toBeDefined();
    expect(route("GET /users/:id")).toBeDefined();
    expect(route("POST /users")).toBeDefined();
    expect(links("GET /users", "list_users")).toBe(true);
  });

  it("ignores functions without a route attribute", () => {
    expect(result.nodes.filter((n) => n.kind === "Route")).toHaveLength(3);
  });
});
