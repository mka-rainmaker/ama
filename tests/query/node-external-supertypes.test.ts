import { describe, expect, it } from "vitest";
import type { GraphNode, NodeKind } from "../../src/graph/index.js";
import { TYPE_REF_PREFIX } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function n(id: string, name: string, kind: NodeKind, file: string, qn: string): GraphNode {
  return {
    id,
    kind,
    name,
    file,
    qualifiedName: qn,
    tier: "baseline",
    range: { startLine: 1, endLine: 1 },
  };
}

/**
 * A class C that implements an in-repo interface I (resolved), and also extends `AbstractBase` and
 * implements `Runnable` — dependency types with no on-disk source node, so the Java analyzer left a
 * `type:<Name>` candidate edge that never resolved. The candidate edge survives in the store; the
 * inheritance queries skip it (its target isn't a real node). node() should surface those names so
 * the dependency gap is visible, not silently dropped. (#47)
 */
function svc(): QueryService {
  const s = new InMemoryStore();
  s.addNode(n("c.ts#C", "C", "Class", "c.ts", "C"));
  s.addNode(n("i.ts#I", "I", "Interface", "i.ts", "I"));
  // Resolved: C implements I (real node) — plus the raw candidate the indexer also keeps.
  s.addEdge({ from: "c.ts#C", to: "i.ts#I", kind: "Implements", provenance: "type" });
  s.addEdge({
    from: "c.ts#C",
    to: `${TYPE_REF_PREFIX}I`,
    kind: "Implements",
    provenance: "heuristic",
  });
  // Unresolved external supertypes (dependency types, no on-disk node).
  s.addEdge({
    from: "c.ts#C",
    to: `${TYPE_REF_PREFIX}AbstractBase`,
    kind: "Inherits",
    provenance: "heuristic",
  });
  s.addEdge({
    from: "c.ts#C",
    to: `${TYPE_REF_PREFIX}Runnable`,
    kind: "Implements",
    provenance: "heuristic",
  });
  return new QueryService(s, "/repo");
}

describe("node() surfaces unresolved external supertypes/interfaces (#47)", () => {
  it("lists external (unresolved) supertypes and interfaces by name, sorted", () => {
    const view = svc().node("C");
    if (!view) throw new Error("expected a node");
    expect(view.externalSupertypes).toEqual(["AbstractBase", "Runnable"]);
  });

  it("excludes a supertype that also resolved to an indexed type (no double-count)", () => {
    const view = svc().node("C");
    if (!view) throw new Error("expected a node");
    expect(view.externalSupertypes).not.toContain("I");
    expect(view.interfaces.map((x) => x.qualifiedName)).toEqual(["I"]);
  });

  it("is empty for a node whose supertypes all resolve", () => {
    const s = new InMemoryStore();
    s.addNode(n("a.ts#A", "A", "Class", "a.ts", "A"));
    s.addNode(n("b.ts#B", "B", "Class", "b.ts", "B"));
    s.addEdge({ from: "a.ts#A", to: "b.ts#B", kind: "Inherits", provenance: "type" });
    const view = new QueryService(s, "/repo").node("A");
    if (!view) throw new Error("expected a node");
    expect(view.externalSupertypes).toEqual([]);
  });
});
