import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { symbolId } from "../../../src/graph/index.js";
import { createDefaultIndexer } from "../../../src/indexer/indexer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/php-basic");
const sym = (qualifiedName: string) => symbolId({ file: "Sample.php", qualifiedName });

describe("PHP baseline analyzer (wired into the default indexer)", () => {
  it("indexes .php files at the baseline tier", async () => {
    const { store, stats } = await createDefaultIndexer().index(root);

    expect(stats.languages).toContainEqual(
      expect.objectContaining({ language: "php", tier: "baseline" }),
    );

    expect(store.getNode(sym("Sample"))?.kind).toBe("Class");
    expect(store.getNode(sym("Sample"))?.tier).toBe("baseline");
    // Methods nest under their class.
    expect(store.getNode(sym("Sample.square"))?.kind).toBe("Method");
    expect(store.getNode(sym("Greeter"))?.kind).toBe("Interface");
    // A trait is class-like; an enum and a free function map too.
    expect(store.getNode(sym("Loggable"))?.kind).toBe("Class");
    expect(store.getNode(sym("Suit"))?.kind).toBe("Enum");
    expect(store.getNode(sym("helper"))?.kind).toBe("Function");
  });
});
