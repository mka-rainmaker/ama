import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";
import { QueryService } from "../../src/query/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/search-code");

/**
 * search_code scanned each symbol's body for the query as one literal substring,
 * so a conceptual multi-word query returned nothing unless the exact phrase
 * appeared. It should prefer a literal-phrase match (grep semantics) but fall back
 * to term-matching when the phrase isn't found. (ama-ejh)
 */
describe("search_code falls back to term-matching for multi-word queries (ama-ejh)", () => {
  it("finds a symbol whose body has all the terms but not as a contiguous phrase", async () => {
    const { store } = await createDefaultIndexer().index(root);
    const q = new QueryService(store, root);
    // baselineHandler's body has "baseline" (its name) and "import" (a comment),
    // but never the literal "baseline import".
    const names = q.searchCode("baseline import").map((n) => n.name);
    expect(names).toContain("baselineHandler");
  });

  it("still prefers a literal contiguous-phrase match", async () => {
    const { store } = await createDefaultIndexer().index(root);
    const q = new QueryService(store, root);
    const names = q.searchCode("resolves an import").map((n) => n.name);
    expect(names).toContain("baselineHandler");
  });
});

/**
 * An empty query's phrase ("") is a substring of every body, so without a guard
 * search_code returns arbitrary symbols up to the limit — the sibling bug to
 * ama-k3d (search_symbol). A blank query has nothing to find. (ama-d36)
 */
describe("search_code empty-query handling (ama-d36)", () => {
  it("returns nothing for an empty or whitespace query", async () => {
    const { store } = await createDefaultIndexer().index(root);
    const q = new QueryService(store, root);
    expect(q.searchCode("")).toEqual([]);
    expect(q.searchCode("   ")).toEqual([]);
  });

  it("still matches a real term", async () => {
    const { store } = await createDefaultIndexer().index(root);
    const q = new QueryService(store, root);
    expect(q.searchCode("baseline").map((n) => n.name)).toContain("baselineHandler");
  });
});
