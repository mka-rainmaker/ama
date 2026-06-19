import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { symbolId } from "../../../src/graph/index.js";
import { createDefaultIndexer } from "../../../src/indexer/indexer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/swift-basic");
const sym = (qualifiedName: string) => symbolId({ file: "Sample.swift", qualifiedName });

describe("Swift baseline analyzer (wired into the default indexer)", () => {
  it("indexes .swift files: classes, structs, methods, protocols, enums, functions", async () => {
    const { store, stats } = await createDefaultIndexer().index(root);

    expect(stats.languages).toContainEqual(
      expect.objectContaining({ language: "swift", tier: "baseline" }),
    );
    expect(store.getNode(sym("Sample"))?.kind).toBe("Class");
    // A method nests under its class.
    expect(store.getNode(sym("Sample.square"))?.kind).toBe("Function");
    // struct is also a class_declaration -> Class at the baseline tier.
    expect(store.getNode(sym("Point"))?.kind).toBe("Class");
    // protocol -> Interface.
    expect(store.getNode(sym("Greeter"))?.kind).toBe("Interface");
    // enum -> Enum (refined by its enum_class_body).
    expect(store.getNode(sym("Color"))?.kind).toBe("Enum");
    expect(store.getNode(sym("helper"))?.kind).toBe("Function");
  });
});
