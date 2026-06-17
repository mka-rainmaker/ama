import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { symbolId } from "../../../src/graph/index.js";
import { createDefaultIndexer } from "../../../src/indexer/indexer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/rust-basic");
const sym = (qualifiedName: string) => symbolId({ file: "sample.rs", qualifiedName });

describe("Rust baseline analyzer (wired into the default indexer)", () => {
  it("indexes .rs files at the baseline tier with distinct kinds", async () => {
    const { store, stats } = await createDefaultIndexer().index(root);

    expect(stats.languages).toContainEqual(
      expect.objectContaining({ language: "rust", tier: "baseline" }),
    );

    const shape = store.getNode(sym("Shape"));
    expect(shape?.kind).toBe("Interface"); // trait_item
    expect(shape?.tier).toBe("baseline");
    expect(store.getNode(sym("Circle"))?.kind).toBe("Class"); // struct_item
    expect(store.getNode(sym("Color"))?.kind).toBe("Enum"); // enum_item
    expect(store.getNode(sym("main"))?.kind).toBe("Function"); // function_item
    // A trait method nests under the trait.
    expect(store.getNode(sym("Shape.area"))?.kind).toBe("Function");
  });
});
