import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { symbolId } from "../../../src/graph/index.js";
import { createDefaultIndexer } from "../../../src/indexer/indexer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/js-basic");
const sym = (qualifiedName: string) => symbolId({ file: "sample.js", qualifiedName });

describe("JavaScript baseline analyzer (wired into the default indexer)", () => {
  it("indexes .js files at the baseline tier", async () => {
    const { store, stats } = await createDefaultIndexer().index(root);

    expect(stats.languages).toContainEqual(
      expect.objectContaining({ language: "javascript", tier: "baseline" }),
    );

    const add = store.getNode(sym("add"));
    expect(add?.kind).toBe("Function");
    expect(add?.tier).toBe("baseline");
    expect(store.getNode(sym("Calc"))?.kind).toBe("Class");
    // JS distinguishes methods syntactically, so a class method is a Method node.
    expect(store.getNode(sym("Calc.square"))?.kind).toBe("Method");
  });
});
