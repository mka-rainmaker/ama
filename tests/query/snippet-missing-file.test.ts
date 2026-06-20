import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function symbol(): GraphNode {
  return {
    id: "missing.ts#X",
    kind: "Function",
    name: "X",
    file: "missing.ts",
    qualifiedName: "X",
    tier: "deep",
    range: { startLine: 1, endLine: 3 },
  };
}

/**
 * getCodeSnippet read the node's file unguarded, so node()/get_code_snippet threw
 * ENOENT when the file had vanished since indexing (a stale index entry). It should
 * skip gracefully — no snippet — like searchCode does, so the query still answers.
 * (ama-pdz)
 */
describe("getCodeSnippet tolerates a missing file (ama-pdz)", () => {
  function service(): QueryService {
    const store = new InMemoryStore();
    store.addNode(symbol());
    return new QueryService(store, "/no-such-root");
  }

  it("returns no snippet instead of throwing", () => {
    expect(service().getCodeSnippet("X")).toBeUndefined();
  });

  it("lets node() still return the node and its relationships", () => {
    const view = service().node("X");
    expect(view?.node.id).toBe("missing.ts#X");
    expect(view?.snippet).toBeUndefined();
  });
});
