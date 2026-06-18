import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { AmaSession } from "../src/mcp/session.js";

// The project's built-in regression gate: Ama indexes its own source and the
// resulting graph contains the symbols and edges we know it defines. If this
// goes red, a change broke the deep TypeScript pipeline end to end.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "src");

describe("self-index regression gate", () => {
  const session = new AmaSession();
  beforeAll(async () => {
    await session.indexRepository(srcRoot);
  });

  it("indexes its own source as deep-tier TypeScript", () => {
    const status = session.indexStatus();
    expect(status.indexed).toBe(true);
    if (status.indexed) {
      expect(status.fileCount).toBeGreaterThan(5);
      expect(status.nodeCount).toBeGreaterThan(20);
      expect(status.languages).toEqual([
        expect.objectContaining({ language: "typescript", tier: "deep" }),
      ]);
    }
  });

  it("makes the classes it defines discoverable", () => {
    for (const cls of [
      "TypeScriptAnalyzer",
      "InMemoryStore",
      "QueryService",
      "AmaSession",
      "Indexer",
    ]) {
      const hit = session.searchSymbol(cls).some((n) => n.kind === "Class");
      expect(hit, `expected to find class ${cls}`).toBe(true);
    }
  });

  it("resolves a real internal call edge (getCodeSnippet -> resolve)", () => {
    const callees = session.findCallees("getCodeSnippet").map((n) => n.symbol.name);
    expect(callees).toContain("resolve");
  });

  it("returns verbatim source for one of its own symbols", () => {
    const snip = session.getCodeSnippet("symbolId");
    expect(snip?.text).toContain("qualifiedName");
  });

  it("indexes its own type aliases as nodes (e.g. EdgeKind)", () => {
    const hit = session.searchSymbol("EdgeKind").some((n) => n.kind === "TypeAlias");
    expect(hit, "expected the EdgeKind type alias to be a graph node").toBe(true);
  });

  it("tracks construction (new-expressions) as Calls edges", () => {
    // AmaSession.indexRepository does `new QueryService(...)`, so it must show
    // up as a caller of QueryService now that new-expressions are call sites.
    const callers = session.findCallers("QueryService").map((n) => n.symbol.name);
    expect(callers).toContain("indexRepository");
  });

  it("indexes function-valued const declarations (e.g. fsWatchSource)", () => {
    const hit = session.searchSymbol("fsWatchSource").some((n) => n.kind === "Function");
    expect(hit, "expected the fsWatchSource arrow const to be a Function node").toBe(true);
  });

  it("resolves calls made through an interface to the interface method", () => {
    // QueryService.findCallers calls this.store.edgesTo, where store is the
    // Store *interface* — that call only resolves once interface methods are nodes.
    const callees = session.findCallees("QueryService.findCallers").map((n) => n.symbol.name);
    expect(callees).toContain("edgesTo");
  });

  it("fans interface-mediated calls out to implementations (virtual dispatch)", () => {
    // QueryService calls this.store.edgesTo (store: Store), which dispatch should
    // fan out to the concrete InMemoryStore.edgesTo.
    const callers = session.findCallers("InMemoryStore.edgesTo").map((n) => n.symbol.name);
    expect(callers).toContain("findCallers");
  });
});
