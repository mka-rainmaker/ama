import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function file(id: string): GraphNode {
  return { id, kind: "File", name: id, file: id, qualifiedName: "", tier: "deep" };
}
function sym(fileId: string, name: string): GraphNode {
  return {
    id: `${fileId}#${name}`,
    kind: "Function",
    name,
    file: fileId,
    qualifiedName: name,
    tier: "deep",
  };
}

function setup(): QueryService {
  const store = new InMemoryStore();
  store.addNode(file("src/b.ts"));
  store.addNode(file("src/c.ts"));
  store.addNode(file("tests/a.test.ts"));
  store.addNode(sym("src/b.ts", "x"));
  store.addEdge({ from: "src/b.ts", to: "src/b.ts#x", kind: "Defines" });
  store.addEdge({ from: "src/c.ts", to: "src/b.ts#x", kind: "Imports" });
  store.addEdge({ from: "tests/a.test.ts", to: "src/b.ts#x", kind: "Imports" });
  return new QueryService(store, "/repo");
}

describe("affected test-impact mode (ama-5gs.9)", () => {
  it("returns all affected files by default", () => {
    expect(
      setup()
        .affected(["src/b.ts"])
        .map((n) => n.id)
        .sort(),
    ).toEqual(["src/c.ts", "tests/a.test.ts"]);
  });

  it("filters the closure to test files with testsOnly", () => {
    expect(
      setup()
        .affected(["src/b.ts"], { testsOnly: true })
        .map((n) => n.id),
    ).toEqual(["tests/a.test.ts"]);
  });
});
