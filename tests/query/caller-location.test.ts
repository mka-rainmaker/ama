import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function fn(id: string, file: string): GraphNode {
  const name = id.split("#")[1] ?? id;
  return { id, kind: "Function", name, file, qualifiedName: name, tier: "deep" };
}

function seeded(): QueryService {
  const store = new InMemoryStore();
  store.addNode(fn("src/a.ts#caller", "src/a.ts"));
  store.addNode(fn("src/b.ts#target", "src/b.ts"));
  store.addEdge({
    from: "src/a.ts#caller",
    to: "src/b.ts#target",
    kind: "Calls",
    at: { line: 6, column: 10 },
  });
  return new QueryService(store, "/repo");
}

describe("call-site location in find_callers/find_callees (ama-2i1)", () => {
  it("findCallers returns the caller with the call-site location", () => {
    const callers = seeded().findCallers("target");
    expect(callers[0]?.symbol.id).toBe("src/a.ts#caller");
    expect(callers[0]?.at).toEqual({ line: 6, column: 10 });
  });

  it("findCallees returns the callee with the call-site location", () => {
    const callees = seeded().findCallees("caller");
    expect(callees[0]?.symbol.id).toBe("src/b.ts#target");
    expect(callees[0]?.at).toEqual({ line: 6, column: 10 });
  });
});
