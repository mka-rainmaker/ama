import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { symbolId } from "../../../src/graph/index.js";
import { createDefaultIndexer } from "../../../src/indexer/indexer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/go-basic");
const sym = (qualifiedName: string) => symbolId({ file: "sample.go", qualifiedName });

describe("Go baseline analyzer (wired into the default indexer)", () => {
  it("indexes .go files at baseline tier, discriminating struct vs interface", async () => {
    const { store, stats } = await createDefaultIndexer().index(root);

    expect(stats.languages).toContainEqual(
      expect.objectContaining({ language: "go", tier: "baseline" }),
    );

    // kind-by-child: a type_spec whose body is a struct_type → Class…
    const circle = store.getNode(sym("Circle"));
    expect(circle?.kind).toBe("Class");
    expect(circle?.tier).toBe("baseline");
    // …and an interface_type → Interface.
    expect(store.getNode(sym("Shape"))?.kind).toBe("Interface");

    expect(store.getNode(sym("main"))?.kind).toBe("Function");
    expect(store.getNode(sym("Area"))?.kind).toBe("Method");
  });
});
