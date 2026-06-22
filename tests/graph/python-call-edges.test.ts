import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { index } from "../../src/api.js";
import type { GraphEdge, GraphNode } from "../../src/graph/index.js";
import { CALL_REF_PREFIX, deriveCallEdges, fileId, symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function node(
  over: Partial<GraphNode> & { id: string; kind: GraphNode["kind"]; file: string },
): GraphNode {
  return { name: over.id, qualifiedName: over.id, tier: "baseline", ...over };
}

/**
 * Cross-file call resolution: the baseline analyzer emits a `call:<name>` candidate for a
 * non-local call; deriveCallEdges resolves it to a function defined in a file the caller imports,
 * emitting a `Calls` edge — so callers/blastRadius/affected reach across modules. (ama-bnj slice 2) */
describe("deriveCallEdges — import-guided cross-file resolution (ama-bnj slice 2)", () => {
  const handlerId = symbolId({ file: "routes.py", qualifiedName: "handler" });
  const targetId = symbolId({ file: "helpers.py", qualifiedName: "get_publisher" });

  it("resolves a call:<name> candidate to a function in an imported file", () => {
    const nodes: GraphNode[] = [
      node({
        id: fileId("routes.py"),
        kind: "File",
        file: "routes.py",
        name: "routes.py",
        qualifiedName: "",
      }),
      node({
        id: fileId("helpers.py"),
        kind: "File",
        file: "helpers.py",
        name: "helpers.py",
        qualifiedName: "",
      }),
      node({
        id: handlerId,
        kind: "Function",
        file: "routes.py",
        name: "handler",
        qualifiedName: "handler",
      }),
      node({
        id: targetId,
        kind: "Function",
        file: "helpers.py",
        name: "get_publisher",
        qualifiedName: "get_publisher",
      }),
    ];
    const edges: GraphEdge[] = [
      { from: fileId("routes.py"), to: fileId("helpers.py"), kind: "Imports" },
      {
        from: handlerId,
        to: `${CALL_REF_PREFIX}get_publisher`,
        kind: "References",
        provenance: "call-ref",
      },
    ];
    expect(deriveCallEdges(nodes, edges)).toContainEqual({
      from: handlerId,
      to: targetId,
      kind: "Calls",
      provenance: "call",
    });
  });

  it("drops a candidate whose name is in no imported file", () => {
    const nodes: GraphNode[] = [
      node({
        id: fileId("routes.py"),
        kind: "File",
        file: "routes.py",
        name: "routes.py",
        qualifiedName: "",
      }),
      node({
        id: handlerId,
        kind: "Function",
        file: "routes.py",
        name: "handler",
        qualifiedName: "handler",
      }),
    ];
    const edges: GraphEdge[] = [
      { from: handlerId, to: `${CALL_REF_PREFIX}nope`, kind: "References", provenance: "call-ref" },
    ];
    expect(deriveCallEdges(nodes, edges)).toEqual([]);
  });
});

describe("Python cross-file calls end-to-end (ama-bnj slice 2)", () => {
  it("find_callers resolves an imported helper across files", async () => {
    const ama = await index(path.resolve(here, "../fixtures/py-calls-xfile"));
    try {
      const callers = ama.findCallers("get_publisher").map((c) => c.symbol.name);
      expect(callers).toContain("handler");
    } finally {
      ama.close();
    }
  });
});
