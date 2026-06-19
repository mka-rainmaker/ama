import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileId } from "../../src/graph/index.js";
import { BASE_IGNORE_RULES, isIgnoredPath, loadIgnoreRules } from "../../src/indexer/ignore.js";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/gitignore-proj");

describe("gitignore-aware file discovery (ama-2eu)", () => {
  it("folds .gitignore bare names and globs into the ignore rules", () => {
    const rules = loadIgnoreRules(root);
    // a directory pattern `generated/`
    expect(rules.names.has("generated")).toBe(true);
    // a glob pattern `*.gen.ts`
    expect(isIgnoredPath("src/thing.gen.ts", rules)).toBe(true);
    expect(isIgnoredPath("generated/skip.ts", rules)).toBe(true);
    // a normal file is kept
    expect(isIgnoredPath("src/keep.ts", rules)).toBe(false);
    // the built-in rules (no .gitignore) don't ignore these
    expect(isIgnoredPath("src/thing.gen.ts", BASE_IGNORE_RULES)).toBe(false);
  });

  it("excludes .gitignored files from the index", async () => {
    const { store } = await createDefaultIndexer().index(root);
    expect(store.getNode(fileId("src/keep.ts"))).toBeDefined();
    expect(store.getNode(fileId("generated/skip.ts"))).toBeUndefined();
    expect(store.getNode(fileId("src/thing.gen.ts"))).toBeUndefined();
  });
});
