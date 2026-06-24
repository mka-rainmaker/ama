import { describe, expect, it } from "vitest";
import { exportCodeIntel } from "../../src/export/codeintel.js";
import type { GraphNode, NodeKind } from "../../src/graph/index.js";
import { InMemoryStore } from "../../src/store/memory.js";

function n(id: string, name: string, kind: NodeKind, file: string, qn: string): GraphNode {
  return {
    id,
    kind,
    name,
    file,
    qualifiedName: qn,
    tier: "deep",
    range: { startLine: 1, endLine: 5 },
  };
}

describe("exportCodeIntel", () => {
  it("exports a simple store with a class, method, and call edge", () => {
    const store = new InMemoryStore();

    // Add a File node (not indexed as a symbol).
    store.addNode({
      id: "a.ts",
      kind: "File",
      name: "a.ts",
      file: "a.ts",
      qualifiedName: "a.ts",
      tier: "baseline",
    });

    // Add a Class node and a Method node, both in a.ts.
    const classNode = n("a.ts#Foo", "Foo", "Class", "a.ts", "Foo");
    const methodNode = n("a.ts#Foo.bar", "bar", "Method", "a.ts", "Foo.bar");
    store.addNode(classNode);
    store.addNode(methodNode);

    // Add edges: Foo defines bar (structure), and bar calls something else.
    // We'll add a Calls edge from bar to Foo to create a reference.
    store.addEdge({
      from: "a.ts#Foo",
      to: "a.ts#Foo.bar",
      kind: "Defines",
      provenance: "resolved",
    });
    store.addEdge({
      from: "a.ts#Foo.bar",
      to: "a.ts#Foo",
      kind: "Calls",
      provenance: "resolved",
    });

    const index = exportCodeIntel(store, "/repo");

    // Verify the index structure.
    expect(index.version).toBe("0.1");
    expect(index.root).toBe("/repo");
    expect(index.documents).toHaveLength(1);

    const doc = index.documents[0];
    expect(doc.path).toBe("a.ts");

    // Check symbols: Foo and bar (not File).
    expect(doc.symbols).toHaveLength(2);
    expect(doc.symbols.map((s) => s.symbol)).toEqual(["a.ts#Foo", "a.ts#Foo.bar"]);
    expect(doc.symbols.map((s) => s.kind)).toEqual(["Class", "Method"]);
    expect(doc.symbols.map((s) => s.name)).toEqual(["Foo", "bar"]);

    // Check occurrences:
    // - definition of Foo
    // - definition of bar
    // - reference from bar (Calls edge) to Foo
    expect(doc.occurrences).toHaveLength(3);

    const definitions = doc.occurrences.filter((o) => o.role === "definition");
    const references = doc.occurrences.filter((o) => o.role === "reference");

    expect(definitions).toHaveLength(2);
    expect(definitions.map((d) => d.symbol)).toEqual(["a.ts#Foo", "a.ts#Foo.bar"]);

    expect(references).toHaveLength(1);
    expect(references[0].symbol).toBe("a.ts#Foo");
  });

  it("ignores Defines edges and only includes reference edges", () => {
    const store = new InMemoryStore();

    // Two nodes in different files.
    const aNode = n("a.ts#A", "A", "Class", "a.ts", "A");
    const bNode = n("b.ts#B", "B", "Class", "b.ts", "B");
    store.addNode(aNode);
    store.addNode(bNode);

    // A Defines itself (structure) — should not create a reference.
    // B Calls A (reference) — should create a reference.
    store.addEdge({
      from: "a.ts#A",
      to: "a.ts#A",
      kind: "Defines",
      provenance: "resolved",
    });
    store.addEdge({
      from: "b.ts#B",
      to: "a.ts#A",
      kind: "Calls",
      provenance: "resolved",
    });

    const index = exportCodeIntel(store, "/repo");

    // Two documents for a.ts and b.ts.
    expect(index.documents).toHaveLength(2);

    const docA = index.documents.find((d) => d.path === "a.ts");
    const docB = index.documents.find((d) => d.path === "b.ts");

    // docA has A as a symbol and one definition occurrence (no references from Defines).
    expect(docA?.symbols.map((s) => s.symbol)).toEqual(["a.ts#A"]);
    expect(docA?.occurrences).toHaveLength(1);
    expect(docA?.occurrences[0].role).toBe("definition");

    // docB has B as a symbol, one definition occurrence, and one reference (Calls to A).
    expect(docB?.symbols.map((s) => s.symbol)).toEqual(["b.ts#B"]);
    expect(docB?.occurrences).toHaveLength(2);
    const bDefs = docB?.occurrences.filter((o) => o.role === "definition") ?? [];
    const bRefs = docB?.occurrences.filter((o) => o.role === "reference") ?? [];
    expect(bDefs).toHaveLength(1);
    expect(bRefs).toHaveLength(1);
    expect(bRefs[0].symbol).toBe("a.ts#A");
  });

  it("preserves symbol ranges and omits ranges for reference occurrences", () => {
    const store = new InMemoryStore();

    // A node with a range.
    const nodeWithRange = n("a.ts#Foo", "Foo", "Class", "a.ts", "Foo");
    store.addNode(nodeWithRange);

    const index = exportCodeIntel(store, "/repo");
    const doc = index.documents[0];

    // Symbol should have the range.
    expect(doc.symbols[0].range).toEqual({ startLine: 1, endLine: 5 });

    // Definition occurrence should have the range.
    expect(doc.occurrences[0].range).toEqual({ startLine: 1, endLine: 5 });
  });
});
