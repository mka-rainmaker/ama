import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-isolation");

/**
 * The per-file passes that loop over files inside analyze(): a throw in any of
 * them on one file must degrade to skipping that file, not abort the whole
 * TypeScript batch — which the indexer's per-analyzer catch would otherwise turn
 * into *every* .ts file vanishing from the graph. Each pass takes the SourceFile
 * as its first argument, so we can inject a fault for exactly one file. (ama-bm2,
 * the finer-grained follow-up to the baseline's per-file isolation in ama-eww.)
 */
const PER_FILE_PASSES = ["walkFile", "collectMounts", "collectCalls"] as const;

describe("TypeScriptAnalyzer per-file isolation (ama-bm2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(PER_FILE_PASSES)(
    "isolates a throw in %s on one file so the others still index",
    (pass) => {
      const analyzer = new TypeScriptAnalyzer();
      const proto = Object.getPrototypeOf(analyzer) as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      const original = proto[pass];
      vi.spyOn(proto, pass).mockImplementation(function (this: unknown, ...args: unknown[]) {
        const sf = args[0] as { fileName?: string } | undefined;
        if (sf?.fileName?.endsWith("boom.ts")) {
          throw new Error(`simulated pathological file in ${pass}`);
        }
        return original.apply(this, args);
      });

      // boom.ts is listed FIRST so, without isolation, its throw aborts the loop
      // before good.ts is reached — making good.ts's survival the actual proof.
      const result = analyzer.analyze(root, ["boom.ts", "good.ts"]);

      const goodFile = result.nodes.find((n) => n.kind === "File" && n.file === "good.ts");
      expect(goodFile, "good.ts should still be indexed despite boom.ts throwing").toBeDefined();
      // its symbols survived too (the structural walk ran for good.ts)
      expect(result.nodes.some((n) => n.file === "good.ts" && n.name === "caller")).toBe(true);
    },
  );
});
