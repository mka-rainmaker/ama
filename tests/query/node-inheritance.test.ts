import { describe, expect, it } from "vitest";
import type { GraphNode, NodeKind } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function n(id: string, name: string, kind: NodeKind, file: string, qn: string): GraphNode {
  return {
    id,
    kind,
    name,
    file,
    qualifiedName: qn,
    tier: "deep",
    range: { startLine: 1, endLine: 1 },
  };
}

/** An interface I with method foo, and a class C that implements I and overrides foo. */
function svc(): QueryService {
  const s = new InMemoryStore();
  s.addNode(n("i.ts#I", "I", "Interface", "i.ts", "I"));
  s.addNode(n("i.ts#I.foo", "foo", "Method", "i.ts", "I.foo"));
  s.addNode(n("c.ts#C", "C", "Class", "c.ts", "C"));
  s.addNode(n("c.ts#C.foo", "foo", "Method", "c.ts", "C.foo"));
  s.addEdge({ from: "i.ts#I", to: "i.ts#I.foo", kind: "Defines", provenance: "resolved" });
  s.addEdge({ from: "c.ts#C", to: "c.ts#C.foo", kind: "Defines", provenance: "resolved" });
  s.addEdge({ from: "c.ts#C", to: "i.ts#I", kind: "Implements", provenance: "resolved" });
  s.addEdge({ from: "c.ts#C.foo", to: "i.ts#I.foo", kind: "Overrides", provenance: "resolved" });
  return new QueryService(s, "/repo");
}

/** node() is the one-call overview, so it should carry inheritance — who implements
 *  an interface, who overrides a method, what a class implements. (ama-vtp) */
describe("node() includes inheritance relationships (ama-vtp)", () => {
  it("an interface shows its implementations", () => {
    const view = svc().node("I");
    if (!view) throw new Error("expected a node");
    expect(view.implementations.map((x) => x.qualifiedName)).toEqual(["C"]);
    expect(view.interfaces).toEqual([]);
  });

  it("an interface method shows who overrides it", () => {
    const view = svc().node("I.foo");
    if (!view) throw new Error("expected a node");
    expect(view.overriddenBy.map((x) => x.qualifiedName)).toEqual(["C.foo"]);
    expect(view.overrides).toEqual([]);
  });

  it("a class shows the interfaces it implements", () => {
    const view = svc().node("C");
    if (!view) throw new Error("expected a node");
    expect(view.interfaces.map((x) => x.qualifiedName)).toEqual(["I"]);
    expect(view.implementations).toEqual([]);
  });

  it("an override shows the supertype method it overrides", () => {
    const view = svc().node("C.foo");
    if (!view) throw new Error("expected a node");
    expect(view.overrides.map((x) => x.qualifiedName)).toEqual(["I.foo"]);
    expect(view.overriddenBy).toEqual([]);
  });
});
