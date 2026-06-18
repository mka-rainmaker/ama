import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyzerRegistry } from "../../src/analyzers/registry.js";
import type { AnalysisResult, Analyzer } from "../../src/analyzers/types.js";
import type { GraphNode } from "../../src/graph/index.js";
import { Indexer } from "../../src/indexer/indexer.js";

function fakeAnalyzer(language: string, ext: string, analyze: () => AnalysisResult): Analyzer {
  return { language, tier: "baseline", extensions: [ext], analyze };
}

const okNode: GraphNode = {
  id: "b.ok#thing",
  kind: "Function",
  name: "thing",
  file: "b.ok",
  qualifiedName: "thing",
  tier: "baseline",
};

describe("indexer analyzer isolation (ama-m8k.9)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-isolation-"));
    fs.writeFileSync(path.join(dir, "a.bad"), "x");
    fs.writeFileSync(path.join(dir, "b.ok"), "y");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a failing analyzer doesn't abort the index; others survive and the failure is reported", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const registry = new AnalyzerRegistry();
      registry.register(
        fakeAnalyzer("bad", ".bad", () => {
          throw new Error("boom");
        }),
      );
      registry.register(fakeAnalyzer("ok", ".ok", () => ({ nodes: [okNode], edges: [] })));

      const { store, stats } = await new Indexer(registry).index(dir);

      // The good language survived; the failed one is absent from coverage.
      expect(stats.languages.map((l) => l.language)).toEqual(["ok"]);
      expect(stats.fileCount).toBe(1);
      expect(store.getNode("b.ok#thing")).toBeDefined();
      // The failure was surfaced to stderr, not swallowed.
      expect(errors.mock.calls.flat().join(" ")).toContain("bad");
    } finally {
      errors.mockRestore();
    }
  });
});
