import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService, parseSearchQuery } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function node(over: Partial<GraphNode> & { id: string; name: string; file: string }): GraphNode {
  return { kind: "Function", qualifiedName: over.name, tier: "deep", ...over };
}

function setup(): QueryService {
  const store = new InMemoryStore();
  store.addNode(
    node({ id: "src/api/users.ts#getUser", name: "getUser", file: "src/api/users.ts" }),
  );
  store.addNode(
    node({ id: "src/api/users.ts#User", name: "User", kind: "Class", file: "src/api/users.ts" }),
  );
  store.addNode(
    node({ id: "src/web/getUser.ts#getUser", name: "getUser", file: "src/web/getUser.ts" }),
  );
  store.addNode(node({ id: "tools/legacy.py#getUser", name: "getUser", file: "tools/legacy.py" }));
  return new QueryService(store, "/repo");
}

const names = (nodes: GraphNode[]) => nodes.map((n) => n.id).sort();

describe("parseSearchQuery (ama-m8k.3)", () => {
  it("splits filters from free text", () => {
    expect(parseSearchQuery("handler path:src/api kind:Function")).toEqual({
      text: "handler",
      path: "src/api",
      kind: "Function",
    });
  });

  it("supports quoted filter values with spaces", () => {
    expect(parseSearchQuery('foo path:"src/my dir"')).toEqual({ text: "foo", path: "src/my dir" });
  });

  it("leaves a plain query as free text", () => {
    expect(parseSearchQuery("getUser")).toEqual({ text: "getUser" });
  });

  it("keeps an unknown key:value token as text (e.g. a URL)", () => {
    expect(parseSearchQuery("http://example kind:Class")).toEqual({
      text: "http://example",
      kind: "Class",
    });
  });
});

describe("searchSymbol with filters (ama-m8k.3)", () => {
  it("scopes results to a path filter", () => {
    expect(names(setup().searchSymbol("getUser path:src/api"))).toEqual([
      "src/api/users.ts#getUser",
    ]);
  });

  it("filters by kind via the DSL", () => {
    expect(names(setup().searchSymbol("getUser kind:Function"))).toEqual([
      "src/api/users.ts#getUser",
      "src/web/getUser.ts#getUser",
      "tools/legacy.py#getUser",
    ]);
  });

  it("filters by language derived from the file extension", () => {
    expect(names(setup().searchSymbol("getUser lang:python"))).toEqual(["tools/legacy.py#getUser"]);
  });

  it("supports filters with no free text (scans all nodes)", () => {
    expect(names(setup().searchSymbol("path:src/api kind:Class"))).toEqual([
      "src/api/users.ts#User",
    ]);
  });

  it("returns nothing when the kind filter excludes every name match", () => {
    // The getUser matches are Functions, so a kind:Class filter removes them all.
    expect(setup().searchSymbol("getUser kind:Class")).toEqual([]);
  });
});
