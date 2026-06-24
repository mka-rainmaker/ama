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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/java-records");
const FILES = ["com/app/Event.java", "com/app/Payload.java", "com/app/UserEvent.java"];

const id = (file: string, qualifiedName: string) => symbolId({ file, qualifiedName });

describe("Java records", () => {
  let nodes: GraphNode[];
  let raw: GraphEdge[];
  let edges: GraphEdge[];

  beforeAll(async () => {
    const result = await new BaselineAnalyzer(javaSpec).analyze(root, FILES);
    nodes = result.nodes;
    raw = result.edges;
    edges = [...raw, ...deriveTypeEdges(nodes, raw)];
  });

  it("indexes a record declaration as a class-like type with nested methods", () => {
    expect(nodes.find((node) => node.qualifiedName === "UserEvent")?.kind).toBe("Class");
    expect(nodes.find((node) => node.qualifiedName === "UserEvent.label")?.kind).toBe("Method");
  });

  it("emits record component properties with type-use candidates", () => {
    expect(nodes.find((node) => node.qualifiedName === "UserEvent.payload")?.kind).toBe("Property");
    expect(
      raw.some(
        (edge) =>
          edge.kind === "UsesType" &&
          edge.from === id("com/app/UserEvent.java", "UserEvent.payload") &&
          edge.to === `${TYPE_REF_PREFIX}Payload`,
      ),
    ).toBe(true);
  });

  it("resolves record implements and component type edges", () => {
    expect(
      edges.some(
        (edge) =>
          edge.kind === "Implements" &&
          edge.from === id("com/app/UserEvent.java", "UserEvent") &&
          edge.to === id("com/app/Event.java", "Event"),
      ),
    ).toBe(true);
    expect(
      edges.some(
        (edge) =>
          edge.kind === "UsesType" &&
          edge.from === id("com/app/UserEvent.java", "UserEvent.payload") &&
          edge.to === id("com/app/Payload.java", "Payload"),
      ),
    ).toBe(true);
  });
});
