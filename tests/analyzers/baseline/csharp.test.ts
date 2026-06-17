import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { symbolId } from "../../../src/graph/index.js";
import { createDefaultIndexer } from "../../../src/indexer/indexer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/csharp-basic");
const sym = (qualifiedName: string) => symbolId({ file: "Sample.cs", qualifiedName });

describe("C# baseline analyzer (wired into the default indexer)", () => {
  it("indexes .cs files at the baseline tier", async () => {
    const { store, stats } = await createDefaultIndexer().index(root);

    expect(stats.languages).toContainEqual(
      expect.objectContaining({ language: "csharp", tier: "baseline" }),
    );

    const sample = store.getNode(sym("Sample"));
    expect(sample?.kind).toBe("Class");
    expect(sample?.tier).toBe("baseline");
    expect(store.getNode(sym("Sample.Square"))?.kind).toBe("Method");
    expect(store.getNode(sym("IGreeter"))?.kind).toBe("Interface");
  });
});
