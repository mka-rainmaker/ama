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

/**
 * The skeleton should show what a file imports (its outgoing dependencies), deduped to
 * the file level — the symmetric counterpart to `dependents`. (ama-1jv)
 */
describe("file_skeleton lists the file's imports (ama-1jv)", () => {
  it("dedups imported symbols to their source files", () => {
    const s = new InMemoryStore();
    s.addNode(fileNode("a.ts"));
    s.addNode(fileNode("b.ts"));
    // a.ts imports two symbols that both live in b.ts -> one imported file.
    s.addNode({ ...fileNode("b.ts"), id: "b.ts#Thing", kind: "Class", name: "Thing" });
    s.addNode({ ...fileNode("b.ts"), id: "b.ts#Other", kind: "Function", name: "Other" });
    s.addEdge({ from: "a.ts", to: "b.ts#Thing", kind: "Imports", provenance: "resolved" });
    s.addEdge({ from: "a.ts", to: "b.ts#Other", kind: "Imports", provenance: "resolved" });
    const skel = new QueryService(s, "/repo").fileSkeleton("a.ts");
    if (!skel) throw new Error("expected a skeleton");
    expect(skel.imports.map((f) => f.id)).toEqual(["b.ts"]);
  });

  it("is empty for a file that imports nothing", () => {
    const s = new InMemoryStore();
    s.addNode(fileNode("leaf.ts"));
    const skel = new QueryService(s, "/repo").fileSkeleton("leaf.ts");
    if (!skel) throw new Error("expected a skeleton");
    expect(skel.imports).toEqual([]);
  });
});
