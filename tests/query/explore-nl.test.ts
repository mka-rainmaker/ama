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

function store(): QueryService {
  const s = new InMemoryStore();
  s.addNode(file("src/a.ts"));
  s.addNode(file("src/b.ts"));
  s.addNode(file("src/c.ts"));
  s.addNode(node("src/a.ts", "BaselineAnalyzer", "Class")); // matches "baseline"
  s.addNode(node("src/b.ts", "collectImports", "Function")); // matches "import"
  s.addNode(node("src/c.ts", "baselineImportResolver", "Function")); // matches both
  return new QueryService(s, "/repo");
}

/**
 * explore() is the NL entry point, but it delegated to searchSymbol(question),
 * matching the whole question as one name — so a verbose question matched nothing.
 * It should tokenize, search each term, union, and rank a symbol that hits more
 * terms higher. (ama-30q)
 */
describe("explore handles multi-word NL questions (ama-30q)", () => {
  it("unions the question's terms instead of matching it as one string", () => {
    const result = store().explore("how are baseline import edges resolved");
    const symbols = result.relationships.map((r) => r.symbol);
    expect(result.totalMatches).toBeGreaterThanOrEqual(3);
    expect(symbols).toContain("BaselineAnalyzer");
    expect(symbols).toContain("collectImports");
  });

  it("ranks a symbol matching more terms ahead of single-term matches", () => {
    const result = store().explore("baseline import details");
    // baselineImportResolver matches both "baseline" and "import"
    expect(result.relationships[0]?.symbol).toBe("baselineImportResolver");
  });
});
