import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function node(over: Partial<GraphNode> & { id: string; name: string; file: string }): GraphNode {
  return { kind: "Class", qualifiedName: over.name, tier: "deep", ...over };
}

function setup(): QueryService {
  const store = new InMemoryStore();
  store.addNode(node({ id: "src/a.ts#User", name: "User", file: "src/a.ts" }));
  store.addNode(node({ id: "tests/a.test.ts#User", name: "User", file: "tests/a.test.ts" }));
  store.addNode(node({ id: "src/a.ts#UserList", name: "UserList", file: "src/a.ts" }));
  store.addNode(
    node({ id: "src/a.ts#findUser", name: "findUser", kind: "Function", file: "src/a.ts" }),
  );
  return new QueryService(store, "/repo");
}

const order = (q: QueryService, query: string) => q.searchSymbol(query).map((n) => n.id);

describe("searchSymbol relevance ranking (ama-m8k.2)", () => {
  it("ranks an exact match in source first", () => {
    expect(order(setup(), "User")[0]).toBe("src/a.ts#User");
  });

  it("ranks an exact prefix above a mid-name substring", () => {
    const ids = order(setup(), "User");
    expect(ids.indexOf("src/a.ts#UserList")).toBeLessThan(ids.indexOf("src/a.ts#findUser"));
  });

  it("demotes a test-file match below the equivalent source match", () => {
    const ids = order(setup(), "User");
    expect(ids.indexOf("src/a.ts#User")).toBeLessThan(ids.indexOf("tests/a.test.ts#User"));
  });
});
