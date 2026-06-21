import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/snippet-doc");

function fn(name: string, startLine: number, endLine: number): GraphNode {
  return {
    id: `sample.ts#${name}`,
    kind: "Function",
    name,
    file: "sample.ts",
    qualifiedName: name,
    tier: "deep",
    range: { startLine, endLine },
  };
}

function svc(...nodes: GraphNode[]): QueryService {
  const s = new InMemoryStore();
  for (const node of nodes) s.addNode(node);
  return new QueryService(s, root);
}

/**
 * A symbol's range starts at its declaration, so the JSDoc immediately above is left
 * out — yet the doc comment is usually the most useful part. get_code_snippet now
 * extends backward over a contiguous leading comment block. (ama-43e)
 */
describe("get_code_snippet includes the leading doc comment (ama-43e)", () => {
  it("prepends a JSDoc block immediately above the declaration", () => {
    // foo is declared on line 2; its doc is line 1.
    const snip = svc(fn("foo", 2, 4)).getCodeSnippet("foo");
    expect(snip?.startLine).toBe(1);
    expect(snip?.text).toContain("/** Doc comment for foo. */");
    expect(snip?.text).toContain("export function foo()");
  });

  it("does not reach past a blank line to an unrelated comment", () => {
    // bar is on line 6; line 5 is blank, so no comment is pulled in.
    const snip = svc(fn("bar", 6, 8)).getCodeSnippet("bar");
    expect(snip?.startLine).toBe(6);
    expect(snip?.text).not.toContain("Doc comment for foo");
  });
});
