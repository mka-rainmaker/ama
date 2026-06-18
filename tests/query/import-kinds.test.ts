import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function file(id: string): GraphNode {
  return { id, kind: "File", name: id, file: id, qualifiedName: "", tier: "deep" };
}
function sym(fileId: string, name: string): GraphNode {
  return {
    id: `${fileId}#${name}`,
    kind: "Interface",
    name,
    file: fileId,
    qualifiedName: name,
    tier: "deep",
  };
}

describe("type-only import edges (ama-bhf)", () => {
  it("findImporters still counts a type-only (ImportsType) importer as a dependent", () => {
    const store = new InMemoryStore();
    store.addNode(file("a.ts"));
    store.addNode(file("b.ts"));
    store.addNode(sym("b.ts", "X"));
    store.addEdge({ from: "a.ts", to: "b.ts#X", kind: "ImportsType" });
    expect(new QueryService(store, "/repo").findImporters("b.ts#X").map((n) => n.id)).toEqual([
      "a.ts",
    ]);
  });

  it("circularImports ignores a type-only cycle (runtime-erased)", () => {
    const store = new InMemoryStore();
    store.addNode(file("a.ts"));
    store.addNode(file("b.ts"));
    store.addNode(sym("a.ts", "fa"));
    store.addNode(sym("b.ts", "fb"));
    store.addEdge({ from: "a.ts", to: "b.ts#fb", kind: "ImportsType" });
    store.addEdge({ from: "b.ts", to: "a.ts#fa", kind: "ImportsType" });
    expect(new QueryService(store, "/repo").circularImports()).toEqual([]);
  });
});
