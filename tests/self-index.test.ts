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
    const callees = session.findCallees("getCodeSnippet").map((n) => n.name);
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
});
