import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function fn(id: string): GraphNode {
  const name = id.split("#")[1] ?? id;
  return { id, kind: "Function", name, file: "f.ts", qualifiedName: name, tier: "deep" };
}

/** A file with 30 functions all matching the term "item". */
function setup(): QueryService {
  const store = new InMemoryStore();
  store.addNode({
    id: "f.ts",
    kind: "File",
    name: "f.ts",
    file: "f.ts",
    qualifiedName: "",
    tier: "deep",
  });
  for (let i = 0; i < 30; i++) {
    const node = fn(`f.ts#item${i}`);
    store.addNode(node);
    store.addEdge({ from: "f.ts", to: node.id, kind: "Defines" });
  }
  return new QueryService(store, "/repo");
}

describe("explore output budget (ama-m8k.4)", () => {
  it("caps the matches it deep-dives and reports the true total", () => {
    const ex = setup().explore("item", { limit: 5 });
    expect(ex.relationships).toHaveLength(5);
    const shown = Object.values(ex.byFile).reduce((sum, group) => sum + group.length, 0);
    expect(shown).toBe(5);
    // The agent is told how many matched, so it can refine instead of assuming 5 is all.
    expect(ex.totalMatches).toBe(30);
  });

  it("shows everything when matches fit within the budget", () => {
    const ex = setup().explore("item", { limit: 50 });
    expect(ex.relationships).toHaveLength(30);
    expect(ex.totalMatches).toBe(30);
  });
});
