import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { javaSpec } from "../../../src/analyzers/baseline/java.js";
import {
  type GraphEdge,
  type GraphNode,
  TYPE_REF_PREFIX,
  deriveTypeEdges,
  symbolId,
} from "../../../src/graph/index.js";
import { QueryService } from "../../../src/query/service.js";
import { InMemoryStore } from "../../../src/store/memory.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/java-fields");
const FILES = ["com/svc/Svc.java", "com/repo/Repo.java"];

const id = (file: string, qualifiedName: string) => symbolId({ file, qualifiedName });

describe("Java fields: field_declaration → Property + UsesType (ama 0.4.0 S3)", () => {
  let nodes: GraphNode[];
  let raw: GraphEdge[];
  beforeAll(async () => {
    const result = await new BaselineAnalyzer(javaSpec).analyze(root, FILES);
    nodes = result.nodes;
    raw = result.edges;
  });

  it("emits a Property node for a field (Svc.repo)", () => {
    expect(
      nodes.some(
        (n) =>
          n.kind === "Property" && n.file === "com/svc/Svc.java" && n.qualifiedName === "Svc.repo",
      ),
    ).toBe(true);
  });

  it("emits a Defines edge from the class to the field Property", () => {
    expect(
      raw.some(
        (e) =>
          e.kind === "Defines" &&
          e.from === id("com/svc/Svc.java", "Svc") &&
          e.to === id("com/svc/Svc.java", "Svc.repo"),
      ),
    ).toBe(true);
  });

  it("emits a Property per declarator in a multi-declarator field (int a, b;)", () => {
    const props = nodes.filter((n) => n.kind === "Property" && n.file === "com/svc/Svc.java");
    expect(props.map((n) => n.qualifiedName)).toEqual(expect.arrayContaining(["Svc.a", "Svc.b"]));
  });

  it("emits a type: UsesType candidate from the Property to its declared type", () => {
    expect(
      raw.some(
        (e) =>
          e.kind === "UsesType" &&
          e.from === id("com/svc/Svc.java", "Svc.repo") &&
          e.to === `${TYPE_REF_PREFIX}Repo`,
      ),
    ).toBe(true);
  });

  it("does not emit a UsesType candidate for a primitive field type (int a)", () => {
    expect(
      raw.some((e) => e.kind === "UsesType" && e.from === id("com/svc/Svc.java", "Svc.a")),
    ).toBe(false);
  });

  it("strips generics to the base type for a parameterized field (List<Repo> → Repo via type arg only at use sites)", () => {
    // The field's own declared type is `List` (the base), so the field UsesType candidate is List;
    // List has no on-disk node so it simply won't resolve — assert the base candidate is emitted.
    expect(
      raw.some(
        (e) =>
          e.kind === "UsesType" &&
          e.from === id("com/svc/Svc.java", "Svc.cache") &&
          e.to === `${TYPE_REF_PREFIX}List`,
      ),
    ).toBe(true);
  });
});

describe("Java fields resolve cross-file and power find_type_users (ama 0.4.0 S3)", () => {
  let q: QueryService;
  let edges: GraphEdge[];
  beforeAll(async () => {
    const result = await new BaselineAnalyzer(javaSpec).analyze(root, FILES);
    const nodes = result.nodes;
    const base = result.edges.filter((e) => e.provenance !== "type");
    edges = [...base, ...deriveTypeEdges(nodes, base)];
    const store = new InMemoryStore();
    for (const n of nodes) store.addNode(n);
    for (const e of edges) store.addEdge(e);
    q = new QueryService(store, root);
  });

  it("resolves the field UsesType to a cross-file edge", () => {
    expect(
      edges.some(
        (e) =>
          e.kind === "UsesType" &&
          e.provenance === "type" &&
          e.from === id("com/svc/Svc.java", "Svc.repo") &&
          e.to === id("com/repo/Repo.java", "Repo"),
      ),
    ).toBe(true);
  });

  it("find_type_users(Repo) returns the Svc field property", () => {
    const users = q.findTypeUsers("Repo");
    expect(users.map((n) => n.qualifiedName)).toContain("Svc.repo");
  });
});
