import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { symbolId } from "../../../src/graph/index.js";
import { createDefaultIndexer } from "../../../src/indexer/indexer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/py-basic");
const sym = (qualifiedName: string) => symbolId({ file: "sample.py", qualifiedName });

describe("Python baseline analyzer (wired into the default indexer)", () => {
  it("indexes .py files at the baseline tier", async () => {
    const { store, stats } = await createDefaultIndexer().index(root);

    expect(stats.languages).toContainEqual(
      expect.objectContaining({ language: "python", tier: "baseline" }),
    );

    const greet = store.getNode(sym("greet"));
    expect(greet?.kind).toBe("Function");
    expect(greet?.tier).toBe("baseline");
    expect(store.getNode(sym("Greeter"))?.kind).toBe("Class");
    expect(store.getNode(sym("Greeter.hello"))?.kind).toBe("Function");
  });
});
