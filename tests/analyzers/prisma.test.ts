import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PrismaAnalyzer } from "../../src/analyzers/prisma/analyzer.js";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/prisma");

/**
 * The Prisma analyzer parses schema.prisma into a queryable graph: a node per model and
 * enum, fields as properties, and a UsesType edge for every relation between models — so
 * an agent can ask "what uses model X" once the TS linkage (ama-kvv) lands. (ama-cdg)
 */
describe("PrismaAnalyzer (ama-cdg)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new PrismaAnalyzer().analyze(root, ["schema.prisma"]);
  });

  const node = (kind: string, qn: string) =>
    result.nodes.find((n) => n.kind === kind && n.qualifiedName === qn);
  const id = (qn: string) => symbolId({ file: "schema.prisma", qualifiedName: qn });
  const usesType = (from: string, to: string) =>
    result.edges.some((e) => e.kind === "UsesType" && e.from === id(from) && e.to === id(to));

  it("emits a node per model", () => {
    expect(node("Class", "User")).toBeDefined();
    expect(node("Class", "Post")).toBeDefined();
  });

  it("emits a node per enum", () => {
    expect(node("Enum", "Role")).toBeDefined();
  });

  it("emits fields as Property nodes qualified by their model", () => {
    expect(node("Property", "User.email")).toBeDefined();
    expect(node("Property", "Post.authorId")).toBeDefined();
    expect(node("Property", "Post.author")).toBeDefined();
  });

  it("emits a UsesType edge for each relation, both directions", () => {
    expect(usesType("Post", "User")).toBe(true); // author User
    expect(usesType("User", "Post")).toBe(true); // posts Post[]
  });

  it("does NOT treat datasource/generator blocks as models", () => {
    expect(
      result.nodes.some((n) => n.kind === "Class" && (n.name === "db" || n.name === "client")),
    ).toBe(false);
  });
});
