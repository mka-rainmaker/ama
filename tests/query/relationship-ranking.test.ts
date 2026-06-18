import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function fn(id: string, file: string): GraphNode {
  const name = id.split("#")[1] ?? id;
  return { id, kind: "Function", name, file, qualifiedName: name, tier: "deep" };
}

describe("find_* relationship ranking (ama-bc2)", () => {
  it("ranks a source caller above a test-file caller", () => {
    const store = new InMemoryStore();
    store.addNode(fn("src/t.ts#target", "src/t.ts"));
    store.addNode(fn("tests/t.test.ts#testCaller", "tests/t.test.ts"));
    store.addNode(fn("src/s.ts#srcCaller", "src/s.ts"));
    // Add the test caller's edge first, so insertion order alone would list it first.
    store.addEdge({ from: "tests/t.test.ts#testCaller", to: "src/t.ts#target", kind: "Calls" });
    store.addEdge({ from: "src/s.ts#srcCaller", to: "src/t.ts#target", kind: "Calls" });

    const ids = new QueryService(store, "/repo").findCallers("target").map((n) => n.symbol.id);
    expect(ids.indexOf("src/s.ts#srcCaller")).toBeLessThan(
      ids.indexOf("tests/t.test.ts#testCaller"),
    );
  });
});
