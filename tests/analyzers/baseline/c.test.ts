import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { symbolId } from "../../../src/graph/index.js";
import { createDefaultIndexer } from "../../../src/indexer/indexer.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("C / C++ baseline analyzers (wired into the default indexer)", () => {
  it("indexes .c files: functions (declarator name), structs, enums", async () => {
    const root = path.resolve(here, "../../fixtures/c-basic");
    const sym = (q: string) => symbolId({ file: "sample.c", qualifiedName: q });
    const { store, stats } = await createDefaultIndexer().index(root);

    expect(stats.languages).toContainEqual(
      expect.objectContaining({ language: "c", tier: "baseline" }),
    );
    // The function name is nested in a declarator, not a `name` field.
    expect(store.getNode(sym("square"))?.kind).toBe("Function");
    expect(store.getNode(sym("Point"))?.kind).toBe("Class");
    expect(store.getNode(sym("Color"))?.kind).toBe("Enum");
  });

  it("indexes .cpp files: classes, methods, namespaces, free functions", async () => {
    const root = path.resolve(here, "../../fixtures/cpp-basic");
    const sym = (q: string) => symbolId({ file: "sample.cpp", qualifiedName: q });
    const { store, stats } = await createDefaultIndexer().index(root);

    expect(stats.languages).toContainEqual(
      expect.objectContaining({ language: "cpp", tier: "baseline" }),
    );
    expect(store.getNode(sym("Sample"))?.kind).toBe("Class");
    // A method defined inline nests under its class.
    expect(store.getNode(sym("Sample.square"))?.kind).toBe("Function");
    expect(store.getNode(sym("geo"))?.kind).toBe("Module");
    expect(store.getNode(sym("geo.Point"))?.kind).toBe("Class");
    expect(store.getNode(sym("helper"))?.kind).toBe("Function");
  });
});
