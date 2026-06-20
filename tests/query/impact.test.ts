import { describe, expect, it } from "vitest";
import type { GraphNode, NodeKind } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function file(id: string): GraphNode {
  return { id, kind: "File", name: id, file: id, qualifiedName: "", tier: "deep" };
}
function node(fileId: string, name: string, kind: NodeKind): GraphNode {
  return { id: `${fileId}#${name}`, kind, name, file: fileId, qualifiedName: name, tier: "deep" };
}

/**
 * impactAnalysis BFS'd over Calls edges only, so its blast radius was empty for
 * any symbol that is *referenced* rather than *called* — a type, interface, or
 * constant. "What breaks if I change this type?" must follow every dependency
 * edge (UsesType, References, …), not just Calls. (ama-8sw)
 */
describe("impactAnalysis follows all dependency edges, not just Calls (ama-8sw)", () => {
  it("surfaces type users (UsesType) and their transitive callers", () => {
    const store = new InMemoryStore();
    store.addNode(file("src/types.ts"));
    store.addNode(file("src/render.ts"));
    store.addNode(file("src/app.ts"));
    store.addNode(node("src/types.ts", "Widget", "Interface"));
    store.addNode(node("src/render.ts", "render", "Function"));
    store.addNode(node("src/app.ts", "main", "Function"));
    // render USES the Widget type; main CALLS render
    store.addEdge({ from: "src/render.ts#render", to: "src/types.ts#Widget", kind: "UsesType" });
    store.addEdge({ from: "src/app.ts#main", to: "src/render.ts#render", kind: "Calls" });

    const impact = new QueryService(store, "/repo").impactAnalysis("Widget").map((n) => n.id);
    expect(impact).toContain("src/render.ts#render"); // direct type user
    expect(impact).toContain("src/app.ts#main"); // transitive caller of the user
  });

  it("surfaces value references (References)", () => {
    const store = new InMemoryStore();
    store.addNode(file("src/config.ts"));
    store.addNode(file("src/read.ts"));
    store.addNode(node("src/config.ts", "CONFIG", "Variable"));
    store.addNode(node("src/read.ts", "readCfg", "Function"));
    store.addEdge({ from: "src/read.ts#readCfg", to: "src/config.ts#CONFIG", kind: "References" });

    const impact = new QueryService(store, "/repo").impactAnalysis("CONFIG").map((n) => n.id);
    expect(impact).toContain("src/read.ts#readCfg");
  });
});
