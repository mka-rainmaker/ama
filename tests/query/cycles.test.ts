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
    kind: "Function",
    name,
    file: fileId,
    qualifiedName: name,
    tier: "deep",
  };
}

describe("QueryService.circularImports (ama-m8k.7)", () => {
  it("reports a file-level import cycle as a strongly-connected component", () => {
    const store = new InMemoryStore();
    for (const f of ["a.ts", "b.ts", "c.ts"]) store.addNode(file(f));
    store.addNode(sym("a.ts", "fa"));
    store.addNode(sym("b.ts", "fb"));
    // a imports b's symbol and b imports a's symbol -> cycle; c imports a only.
    store.addEdge({ from: "a.ts", to: "b.ts#fb", kind: "Imports" });
    store.addEdge({ from: "b.ts", to: "a.ts#fa", kind: "Imports" });
    store.addEdge({ from: "c.ts", to: "a.ts#fa", kind: "Imports" });

    const cycles = new QueryService(store, "/repo").circularImports();
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.map((n) => n.id)).toEqual(["a.ts", "b.ts"]);
  });

  it("returns no cycles for an acyclic import graph", () => {
    const store = new InMemoryStore();
    for (const f of ["a.ts", "b.ts"]) store.addNode(file(f));
    store.addNode(sym("b.ts", "fb"));
    store.addEdge({ from: "a.ts", to: "b.ts#fb", kind: "Imports" }); // a -> b only
    expect(new QueryService(store, "/repo").circularImports()).toEqual([]);
  });

  it("groups a 3-file cycle into one component", () => {
    const store = new InMemoryStore();
    for (const f of ["a.ts", "b.ts", "c.ts"]) store.addNode(file(f));
    store.addNode(sym("a.ts", "fa"));
    store.addNode(sym("b.ts", "fb"));
    store.addNode(sym("c.ts", "fc"));
    store.addEdge({ from: "a.ts", to: "b.ts#fb", kind: "Imports" });
    store.addEdge({ from: "b.ts", to: "c.ts#fc", kind: "Imports" });
    store.addEdge({ from: "c.ts", to: "a.ts#fa", kind: "Imports" });

    const cycles = new QueryService(store, "/repo").circularImports();
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.map((n) => n.id)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
