import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/types.js";

function node(id: string): GraphNode {
  return { id, kind: "Function", name: id, file: "a.ts", qualifiedName: id, tier: "deep" };
}

function seed(store: Store): Store {
  store.addNode(node("a.ts#x"));
  store.addNode(node("a.ts#y"));
  store.addEdge({ from: "a.ts#x", to: "a.ts#y", kind: "References", provenance: "heuristic" });
  store.addEdge({ from: "a.ts#x", to: "a.ts#y", kind: "Calls" }); // resolved (absent)
  return store;
}

function check(store: Store): void {
  expect(store.edgesFrom("a.ts#x", "References")[0]?.provenance).toBe("heuristic");
  expect(store.edgesFrom("a.ts#x", "Calls")[0]?.provenance).toBeUndefined();
  store.close();
}

describe("edge provenance round-trips through both stores (ama-m8k.1)", () => {
  it("InMemoryStore preserves heuristic provenance and leaves resolved absent", () => {
    check(seed(new InMemoryStore()));
  });

  it("SqliteStore persists heuristic provenance and leaves resolved absent", () => {
    check(seed(new SqliteStore()));
  });

  it("getGraphSchema reports a resolved/heuristic/dispatch breakdown", () => {
    const store = seed(new InMemoryStore());
    const schema = new QueryService(store, "/repo").getGraphSchema();
    expect(schema.edgeProvenance).toEqual({
      resolved: 1,
      heuristic: 1,
      dispatch: 0,
      "prisma-ref": 0,
      prisma: 0,
      "call-ref": 0,
      call: 0,
      type: 0,
      "route-test": 0,
      "env-ref": 0,
      env: 0,
    });
  });
});
