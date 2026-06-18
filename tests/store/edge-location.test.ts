import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { InMemoryStore } from "../../src/store/memory.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/types.js";

function node(id: string): GraphNode {
  return { id, kind: "Function", name: id, file: "a.ts", qualifiedName: id, tier: "deep" };
}

function seed(store: Store): Store {
  store.addNode(node("a.ts#x"));
  store.addNode(node("a.ts#y"));
  store.addEdge({ from: "a.ts#x", to: "a.ts#y", kind: "Calls", at: { line: 6, column: 10 } });
  store.addEdge({ from: "a.ts#x", to: "a.ts#y", kind: "Defines" }); // no location
  return store;
}

function check(store: Store): void {
  expect(store.edgesFrom("a.ts#x", "Calls")[0]?.at).toEqual({ line: 6, column: 10 });
  expect(store.edgesFrom("a.ts#x", "Defines")[0]?.at).toBeUndefined();
  store.close();
}

describe("edge source-location round-trips through both stores (ama-hft.9)", () => {
  it("InMemoryStore preserves the call-site location", () => {
    check(seed(new InMemoryStore()));
  });

  it("SqliteStore persists the call-site location", () => {
    check(seed(new SqliteStore()));
  });
});
