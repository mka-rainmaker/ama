import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../src/graph/index.js";
import { TYPE_REF_PREFIX, deriveTypeEdges, fileId, symbolId } from "../../src/graph/index.js";

function node(
  over: Partial<GraphNode> & { id: string; kind: GraphNode["kind"]; file: string },
): GraphNode {
  return { name: over.id, qualifiedName: over.id, tier: "baseline", ...over };
}

/**
 * Cross-file type resolution: the Java baseline analyzer emits `type:<SimpleName>` candidates on
 * Inherits/Implements/UsesType edges; deriveTypeEdges resolves each to the Class/Interface/Enum it
 * names in the source's own Java package (same directory, no import needed — #34) or a file the
 * source imports, re-emitting the same kind with provenance "type" — so
 * find_implementations/find_overrides/find_type_users light up across modules. (ama 0.4.0 S0, #34) */
describe("deriveTypeEdges — import-guided cross-file type resolution (ama 0.4.0 S0)", () => {
  const dogId = symbolId({ file: "Dog.java", qualifiedName: "Dog" });
  const animalId = symbolId({ file: "Animal.java", qualifiedName: "Animal" });
  const speakableId = symbolId({ file: "Speakable.java", qualifiedName: "Speakable" });
  const fieldId = symbolId({ file: "Dog.java", qualifiedName: "Dog.tag" });

  function baseNodes(): GraphNode[] {
    return [
      node({
        id: fileId("Dog.java"),
        kind: "File",
        file: "Dog.java",
        name: "Dog.java",
        qualifiedName: "",
      }),
      node({
        id: fileId("Animal.java"),
        kind: "File",
        file: "Animal.java",
        name: "Animal.java",
        qualifiedName: "",
      }),
      node({
        id: fileId("Speakable.java"),
        kind: "File",
        file: "Speakable.java",
        name: "Speakable.java",
        qualifiedName: "",
      }),
      node({ id: dogId, kind: "Class", file: "Dog.java", name: "Dog", qualifiedName: "Dog" }),
      node({
        id: animalId,
        kind: "Class",
        file: "Animal.java",
        name: "Animal",
        qualifiedName: "Animal",
      }),
      node({
        id: speakableId,
        kind: "Interface",
        file: "Speakable.java",
        name: "Speakable",
        qualifiedName: "Speakable",
      }),
      node({
        id: fieldId,
        kind: "Property",
        file: "Dog.java",
        name: "tag",
        qualifiedName: "Dog.tag",
      }),
    ];
  }

  it("resolves an Inherits type:<Name> candidate to a Class in an imported file", () => {
    const edges: GraphEdge[] = [
      { from: fileId("Dog.java"), to: fileId("Animal.java"), kind: "Imports" },
      { from: dogId, to: `${TYPE_REF_PREFIX}Animal`, kind: "Inherits", provenance: "heuristic" },
    ];
    expect(deriveTypeEdges(baseNodes(), edges)).toContainEqual({
      from: dogId,
      to: animalId,
      kind: "Inherits",
      provenance: "type",
    });
  });

  it("resolves an Implements candidate to an Interface in an imported file", () => {
    const edges: GraphEdge[] = [
      { from: fileId("Dog.java"), to: fileId("Speakable.java"), kind: "Imports" },
      {
        from: dogId,
        to: `${TYPE_REF_PREFIX}Speakable`,
        kind: "Implements",
        provenance: "heuristic",
      },
    ];
    expect(deriveTypeEdges(baseNodes(), edges)).toContainEqual({
      from: dogId,
      to: speakableId,
      kind: "Implements",
      provenance: "type",
    });
  });

  it("resolves a UsesType candidate from a field to its declaring type", () => {
    const edges: GraphEdge[] = [
      { from: fileId("Dog.java"), to: fileId("Animal.java"), kind: "Imports" },
      { from: fieldId, to: `${TYPE_REF_PREFIX}Animal`, kind: "UsesType", provenance: "heuristic" },
    ];
    expect(deriveTypeEdges(baseNodes(), edges)).toContainEqual({
      from: fieldId,
      to: animalId,
      kind: "UsesType",
      provenance: "type",
    });
  });

  it("resolves a candidate to a type defined in the SAME file (no import needed)", () => {
    const localId = symbolId({ file: "Dog.java", qualifiedName: "Dog.Collar" });
    const nodes = [
      ...baseNodes(),
      node({
        id: localId,
        kind: "Class",
        file: "Dog.java",
        name: "Collar",
        qualifiedName: "Dog.Collar",
      }),
    ];
    const edges: GraphEdge[] = [
      { from: fieldId, to: `${TYPE_REF_PREFIX}Collar`, kind: "UsesType", provenance: "heuristic" },
    ];
    expect(deriveTypeEdges(nodes, edges)).toContainEqual({
      from: fieldId,
      to: localId,
      kind: "UsesType",
      provenance: "type",
    });
  });

  it("drops a candidate whose type is in no imported (or local) file — JDK/JAR supertypes stay unresolved", () => {
    const edges: GraphEdge[] = [
      {
        from: dogId,
        to: `${TYPE_REF_PREFIX}Runnable`,
        kind: "Implements",
        provenance: "heuristic",
      },
    ];
    expect(deriveTypeEdges(baseNodes(), edges)).toEqual([]);
  });

  it("resolves a same-package sibling (same directory) with no import — Java (#34)", () => {
    // Dog and Animal are both at the repo root (same directory = same Java package); Dog has NO
    // `import` of Animal. Same-package resolution connects them — the import-guided path alone can't.
    const edges: GraphEdge[] = [
      { from: dogId, to: `${TYPE_REF_PREFIX}Animal`, kind: "Inherits", provenance: "heuristic" },
    ];
    expect(deriveTypeEdges(baseNodes(), edges)).toContainEqual({
      from: dogId,
      to: animalId,
      kind: "Inherits",
      provenance: "type",
    });
  });

  it("does not resolve across an unimported file in a DIFFERENT package", () => {
    // Cat lives in a different directory (package) than Dog and is not imported → the candidate must
    // drop, not over-resolve. Same-package resolution only reaches same-directory siblings. (#34)
    const catId = symbolId({ file: "zoo/Cat.java", qualifiedName: "Cat" });
    const nodes: GraphNode[] = [
      ...baseNodes(),
      node({
        id: fileId("zoo/Cat.java"),
        kind: "File",
        file: "zoo/Cat.java",
        name: "Cat.java",
        qualifiedName: "",
      }),
      node({ id: catId, kind: "Class", file: "zoo/Cat.java", name: "Cat", qualifiedName: "Cat" }),
    ];
    const edges: GraphEdge[] = [
      { from: dogId, to: `${TYPE_REF_PREFIX}Cat`, kind: "Inherits", provenance: "heuristic" },
    ];
    expect(deriveTypeEdges(nodes, edges)).toEqual([]);
  });

  it("drops a self-referential candidate", () => {
    const edges: GraphEdge[] = [
      { from: dogId, to: `${TYPE_REF_PREFIX}Dog`, kind: "Inherits", provenance: "heuristic" },
    ];
    expect(deriveTypeEdges(baseNodes(), edges)).toEqual([]);
  });

  it("ignores already-resolved (non-candidate) Inherits edges and leaves no duplicates", () => {
    const edges: GraphEdge[] = [
      { from: fileId("Dog.java"), to: fileId("Animal.java"), kind: "Imports" },
      // already resolved local-id edge, not a candidate — must be ignored by the deriver
      { from: dogId, to: animalId, kind: "Inherits", provenance: "type" },
      { from: dogId, to: `${TYPE_REF_PREFIX}Animal`, kind: "Inherits", provenance: "heuristic" },
    ];
    const out = deriveTypeEdges(baseNodes(), edges);
    expect(out).toEqual([{ from: dogId, to: animalId, kind: "Inherits", provenance: "type" }]);
  });

  // ── collision / import-order pinning tests (#41) ──────────────────────────────────────────────

  it("collision: two imported files each defining the same simple type name → first-defined file wins", () => {
    // Animal.java and Speakable.java both define a class named `Blob`. Dog imports Animal THEN
    // Speakable. The first (Animal.java) definition wins because typesByFile is built in nodes
    // iteration order and `if (!byName.has(simple)) byName.set(...)` is first-wins.
    const blobInAnimal = symbolId({ file: "Animal.java", qualifiedName: "Blob" });
    const blobInSpeakable = symbolId({ file: "Speakable.java", qualifiedName: "Blob" });
    const nodes: GraphNode[] = [
      ...baseNodes(),
      node({
        id: blobInAnimal,
        kind: "Class",
        file: "Animal.java",
        name: "Blob",
        qualifiedName: "Blob",
      }),
      // Blob in Speakable.java — defined AFTER Animal in the nodes array → loses
      node({
        id: blobInSpeakable,
        kind: "Class",
        file: "Speakable.java",
        name: "Blob",
        qualifiedName: "Blob",
      }),
    ];
    const edges: GraphEdge[] = [
      { from: fileId("Dog.java"), to: fileId("Animal.java"), kind: "Imports" },
      { from: fileId("Dog.java"), to: fileId("Speakable.java"), kind: "Imports" },
      { from: dogId, to: `${TYPE_REF_PREFIX}Blob`, kind: "UsesType", provenance: "heuristic" },
    ];
    const out = deriveTypeEdges(nodes, edges);
    // Must resolve to exactly one edge pointing at the Animal-file Blob (first-defined wins).
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ from: dogId, to: blobInAnimal, kind: "UsesType", provenance: "type" });
  });

  it("import-loop: resolves when the type lives in the SECOND of two imported files", () => {
    // Dog imports Animal first (no Widget) then Speakable (has Widget).  The resolver must
    // iterate all imported files, so a type only in the SECOND file still resolves.
    const widgetId = symbolId({ file: "Speakable.java", qualifiedName: "Widget" });
    const nodes: GraphNode[] = [
      ...baseNodes(),
      node({
        id: widgetId,
        kind: "Class",
        file: "Speakable.java",
        name: "Widget",
        qualifiedName: "Widget",
      }),
    ];
    const edges: GraphEdge[] = [
      { from: fileId("Dog.java"), to: fileId("Animal.java"), kind: "Imports" }, // Animal has no Widget
      { from: fileId("Dog.java"), to: fileId("Speakable.java"), kind: "Imports" }, // Speakable has Widget
      { from: dogId, to: `${TYPE_REF_PREFIX}Widget`, kind: "UsesType", provenance: "heuristic" },
    ];
    const out = deriveTypeEdges(nodes, edges);
    expect(out).toContainEqual({ from: dogId, to: widgetId, kind: "UsesType", provenance: "type" });
  });
});
