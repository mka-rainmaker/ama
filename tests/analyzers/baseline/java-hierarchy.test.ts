import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { javaSpec } from "../../../src/analyzers/baseline/java.js";
import {
  type GraphEdge,
  type GraphNode,
  TYPE_REF_PREFIX,
  deriveDispatchEdges,
  deriveTypeEdges,
  symbolId,
} from "../../../src/graph/index.js";
import { QueryService } from "../../../src/query/service.js";
import { InMemoryStore } from "../../../src/store/memory.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/java-hierarchy");
const FILES = [
  "com/zoo/Animal.java",
  "com/zoo/Speakable.java",
  "com/zoo/Pet.java",
  "com/zoo/Dog.java",
];

const id = (file: string, qualifiedName: string) => symbolId({ file, qualifiedName });

describe("Java type hierarchy: extends/implements → Inherits/Implements (ama 0.4.0 S1)", () => {
  let raw: GraphEdge[];
  beforeAll(async () => {
    const { edges } = await new BaselineAnalyzer(javaSpec).analyze(root, FILES);
    raw = edges;
  });

  it("emits a type: candidate for a class extends clause", () => {
    expect(
      raw.some(
        (e) =>
          e.kind === "Inherits" &&
          e.from === id("com/zoo/Dog.java", "Dog") &&
          e.to === `${TYPE_REF_PREFIX}Animal`,
      ),
    ).toBe(true);
  });

  it("emits a type: candidate for an interface extends clause", () => {
    expect(
      raw.some(
        (e) =>
          e.kind === "Inherits" &&
          e.from === id("com/zoo/Pet.java", "Pet") &&
          e.to === `${TYPE_REF_PREFIX}Speakable`,
      ),
    ).toBe(true);
  });

  it("emits a type: candidate for a class implements clause", () => {
    expect(
      raw.some(
        (e) =>
          e.kind === "Implements" &&
          e.from === id("com/zoo/Dog.java", "Dog") &&
          e.to === `${TYPE_REF_PREFIX}Pet`,
      ),
    ).toBe(true);
  });
});

describe("Java hierarchy resolves cross-file and derives dispatch (ama 0.4.0 S1)", () => {
  let nodes: GraphNode[];
  let edges: GraphEdge[];
  let q: QueryService;
  beforeAll(async () => {
    const result = await new BaselineAnalyzer(javaSpec).analyze(root, FILES);
    nodes = result.nodes;
    // Mirror the indexer relinker order: types BEFORE dispatch (dispatch consumes resolved hierarchy).
    const base = result.edges.filter((e) => e.provenance !== "type");
    const typed = [...base, ...deriveTypeEdges(nodes, base)];
    const dispatched = [
      ...typed.filter((e) => e.provenance !== "dispatch"),
      ...deriveDispatchEdges(nodes, typed),
    ];
    edges = dispatched;
    const store = new InMemoryStore();
    for (const n of nodes) store.addNode(n);
    for (const e of edges) store.addEdge(e);
    q = new QueryService(store, root);
  });

  it("resolves class extends to a cross-file Inherits edge", () => {
    expect(
      edges.some(
        (e) =>
          e.kind === "Inherits" &&
          e.provenance === "type" &&
          e.from === id("com/zoo/Dog.java", "Dog") &&
          e.to === id("com/zoo/Animal.java", "Animal"),
      ),
    ).toBe(true);
  });

  it("resolves class implements to a cross-file Implements edge", () => {
    expect(
      edges.some(
        (e) =>
          e.kind === "Implements" &&
          e.provenance === "type" &&
          e.from === id("com/zoo/Dog.java", "Dog") &&
          e.to === id("com/zoo/Pet.java", "Pet"),
      ),
    ).toBe(true);
  });

  it("resolves a same-package interface extends (no import) to a cross-file Inherits edge (#34)", () => {
    // Pet.java declares `interface Pet extends Speakable` with NO `import` — Speakable is a
    // same-package sibling, which needs none in Java. The import-guided resolver alone drops it
    // (failure mode #1); same-package resolution must connect Pet → Speakable.
    expect(
      edges.some(
        (e) =>
          e.kind === "Inherits" &&
          e.provenance === "type" &&
          e.from === id("com/zoo/Pet.java", "Pet") &&
          e.to === id("com/zoo/Speakable.java", "Speakable"),
      ),
    ).toBe(true);
  });

  it("derives Dog.speak → Overrides → Animal.speak from the resolved hierarchy", () => {
    expect(
      edges.some(
        (e) =>
          e.kind === "Overrides" &&
          e.from === id("com/zoo/Dog.java", "Dog.speak") &&
          e.to === id("com/zoo/Animal.java", "Animal.speak"),
      ),
    ).toBe(true);
  });

  it("derives Dog.name → Overrides → Pet.name from the resolved interface implementation", () => {
    // Interface-method override: `Dog implements Pet`, Pet declares `name()`, Dog defines it. This is
    // the distinct (higher-value) case for find_overrides against an interface declaration — derived
    // by deriveDispatchEdges from the resolved Implements/Inherits hierarchy, not from class-extends.
    expect(
      edges.some(
        (e) =>
          e.kind === "Overrides" &&
          e.from === id("com/zoo/Dog.java", "Dog.name") &&
          e.to === id("com/zoo/Pet.java", "Pet.name"),
      ),
    ).toBe(true);
  });

  it("find_overrides(Dog.name) returns the interface method Pet.name", () => {
    const ov = q.findOverrides("Dog.name");
    expect(ov.map((c) => c.symbol.qualifiedName)).toContain("Pet.name");
  });

  it("find_overridden_by(Animal.speak) returns the class override Dog.speak", () => {
    const by = q.findOverriddenBy("Animal.speak");
    expect(by.map((c) => c.symbol.qualifiedName)).toContain("Dog.speak");
  });

  it("find_overridden_by(Pet.name) returns the interface implementation Dog.name", () => {
    const by = q.findOverriddenBy("Pet.name");
    expect(by.map((c) => c.symbol.qualifiedName)).toContain("Dog.name");
  });

  it("find_implementations(Pet) returns Dog", () => {
    const impls = q.findImplementations("Pet");
    expect(impls.map((n) => n.qualifiedName)).toContain("Dog");
  });

  it("find_interfaces(Dog) returns Pet", () => {
    const ifaces = q.findInterfaces("Dog");
    expect(ifaces.map((n) => n.qualifiedName)).toContain("Pet");
  });

  it("find_overrides(Dog.speak) returns Animal.speak", () => {
    const ov = q.findOverrides("Dog.speak");
    expect(ov.map((c) => c.symbol.qualifiedName)).toContain("Animal.speak");
  });
});
