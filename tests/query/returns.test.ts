import { describe, expect, it } from "vitest";
import type { GraphNode, NodeKind } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function n(id: string, kind: NodeKind): GraphNode {
  const name = id.split("#")[1] ?? id;
  return { id, kind, name, file: "a.ts", qualifiedName: name, tier: "deep" };
}

function setup(): QueryService {
  const store = new InMemoryStore();
  store.addNode(n("a.ts#build", "Function"));
  store.addNode(n("a.ts#Widget", "Interface"));
  store.addNode(n("a.ts#Gadget", "Class"));
  store.addEdge({ from: "a.ts#build", to: "a.ts#Widget", kind: "UsesType" }); // param
  store.addEdge({ from: "a.ts#build", to: "a.ts#Gadget", kind: "Returns" }); // return
  return new QueryService(store, "/repo");
}

describe("Returns queries (ama-37c)", () => {
  it("findReturns returns only the return type", () => {
    expect(
      setup()
        .findReturns("build")
        .map((t) => t.id),
    ).toEqual(["a.ts#Gadget"]);
  });

  it("findTypesUsed unions UsesType + Returns (param and return)", () => {
    expect(
      setup()
        .findTypesUsed("build")
        .map((t) => t.id)
        .sort(),
    ).toEqual(["a.ts#Gadget", "a.ts#Widget"]);
  });

  it("findTypeUsers of the returned type includes the returning function", () => {
    expect(
      setup()
        .findTypeUsers("Gadget")
        .map((t) => t.id),
    ).toEqual(["a.ts#build"]);
  });
});
