import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-calls");

describe("QueryService", () => {
  let q: QueryService;
  beforeAll(async () => {
    const store = new InMemoryStore();
    const { nodes, edges } = await new TypeScriptAnalyzer().analyze(root, ["calls.ts"]);
    for (const n of nodes) store.addNode(n);
    for (const e of edges) store.addEdge(e);
    q = new QueryService(store, root);
  });

  it("searches symbols by case-insensitive name substring", () => {
    const hits = q.searchSymbol("COMP");
    expect(hits.map((n) => n.qualifiedName)).toContain("Service.compute");
  });

  it("finds all callers of a function", () => {
    const names = q
      .findCallers("helper")
      .map((n) => n.qualifiedName)
      .sort();
    expect(names).toEqual(["Service.compute", "main"]);
  });

  it("finds the callees of a method", () => {
    const callees = q.findCallees("Service.compute");
    expect(callees.map((n) => n.name)).toContain("helper");
  });

  it("returns a verbatim source snippet for a symbol", () => {
    const snip = q.getCodeSnippet("helper");
    expect(snip?.startLine).toBe(1);
    expect(snip?.text).toContain("return 42;");
  });

  it("resolves an exact node id as well as a bare name", () => {
    const byName = q.getCodeSnippet("Service.compute");
    const byId = q.getCodeSnippet("calls.ts#Service.compute");
    expect(byId?.text).toBe(byName?.text);
  });

  it("returns empty / undefined for unknown symbols", () => {
    expect(q.findCallers("doesNotExist")).toEqual([]);
    expect(q.getCodeSnippet("doesNotExist")).toBeUndefined();
  });
});
