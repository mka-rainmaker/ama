import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { symbolId } from "../../../src/graph/index.js";
import { createDefaultIndexer } from "../../../src/indexer/indexer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/kotlin-basic");
const sym = (qualifiedName: string) => symbolId({ file: "Sample.kt", qualifiedName });

describe("Kotlin baseline analyzer (wired into the default indexer)", () => {
  it("indexes .kt files: classes, methods, objects, enums, top-level functions", async () => {
    const { store, stats } = await createDefaultIndexer().index(root);

    expect(stats.languages).toContainEqual(
      expect.objectContaining({ language: "kotlin", tier: "baseline" }),
    );
    // Names have no `name` field — resolved from the first identifier child.
    expect(store.getNode(sym("Sample"))?.kind).toBe("Class");
    // A method nests under its class.
    expect(store.getNode(sym("Sample.square"))?.kind).toBe("Function");
    // interface is also a class_declaration -> Class at the baseline tier.
    expect(store.getNode(sym("Greeter"))?.kind).toBe("Class");
    // object (singleton) is class-like.
    expect(store.getNode(sym("Singleton"))?.kind).toBe("Class");
    expect(store.getNode(sym("Singleton.run"))?.kind).toBe("Function");
    // enum class -> Enum (refined by its enum_class_body).
    expect(store.getNode(sym("Color"))?.kind).toBe("Enum");
    expect(store.getNode(sym("helper"))?.kind).toBe("Function");
  });
});
