import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService, SKELETON_DEPENDENTS_LIMIT } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function fileNode(path: string): GraphNode {
  return {
    id: path,
    kind: "File",
    name: path,
    file: path,
    qualifiedName: "",
    tier: "deep",
    range: { startLine: 1, endLine: 1 },
  };
}

/**
 * A file skeleton is meant to be a cheap outline, but a foundational file can have
 * dozens of dependents — uncapped, the response dwarfs the file it summarizes. The
 * outline (symbols) stays whole; dependents is a bounded preview + a full count. (ama-2by)
 */
describe("file_skeleton bounds its dependents preview (ama-2by)", () => {
  it("caps dependents and reports the full count", () => {
    const s = new InMemoryStore();
    s.addNode(fileNode("f.ts"));
    const total = SKELETON_DEPENDENTS_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      const imp = `i${i}.ts`;
      s.addNode(fileNode(imp));
      s.addEdge({ from: imp, to: "f.ts", kind: "Imports", provenance: "resolved" });
    }
    const skel = new QueryService(s, "/repo").fileSkeleton("f.ts");
    if (!skel) throw new Error("expected a skeleton");
    expect(skel.dependentsTotal).toBe(total);
    expect(skel.dependents.length).toBe(SKELETON_DEPENDENTS_LIMIT);
  });

  it("returns every dependent when under the cap", () => {
    const s = new InMemoryStore();
    s.addNode(fileNode("f.ts"));
    s.addNode(fileNode("one.ts"));
    s.addEdge({ from: "one.ts", to: "f.ts", kind: "Imports", provenance: "resolved" });
    const skel = new QueryService(s, "/repo").fileSkeleton("f.ts");
    if (!skel) throw new Error("expected a skeleton");
    expect(skel.dependentsTotal).toBe(1);
    expect(skel.dependents.length).toBe(1);
  });
});
