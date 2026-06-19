import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function fn(name: string, qualifiedName = name): GraphNode {
  return {
    id: `a.ts#${qualifiedName}`,
    kind: "Function",
    name,
    file: "a.ts",
    qualifiedName,
    tier: "deep",
  };
}

function setup(): QueryService {
  const store = new InMemoryStore();
  store.addNode(fn("buildIndex"));
  store.addNode(fn("build"));
  store.addNode(fn("compute", "Service.compute"));
  return new QueryService(store, "/repo");
}

describe("search low-confidence marker (ama-b79)", () => {
  it("is high-confidence when a result matches by exact name", () => {
    const { results, lowConfidence } = setup().searchSymbolWithConfidence("build");
    expect(results.length).toBeGreaterThan(0);
    expect(lowConfidence).toBe(false);
  });

  it("is high-confidence when a result matches by exact qualified name", () => {
    expect(setup().searchSymbolWithConfidence("Service.compute").lowConfidence).toBe(false);
  });

  it("is low-confidence when the best match is only a substring", () => {
    const { results, lowConfidence } = setup().searchSymbolWithConfidence("uild");
    expect(results.map((r) => r.name).sort()).toEqual(["build", "buildIndex"]);
    expect(lowConfidence).toBe(true);
  });

  it("is not low-confidence when there are no results at all", () => {
    expect(setup().searchSymbolWithConfidence("zzz").lowConfidence).toBe(false);
  });

  it("is not low-confidence for a filters-only query (no free text)", () => {
    expect(setup().searchSymbolWithConfidence("kind:Function").lowConfidence).toBe(false);
  });
});
