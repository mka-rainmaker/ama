import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileId } from "../../src/graph/index.js";
import { BASE_IGNORE_RULES, isIgnoredPath, loadIgnoreRules } from "../../src/indexer/ignore.js";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/gitignore-proj");
const anchoredRoot = path.resolve(here, "../fixtures/gitignore-anchored");
const globstarRoot = path.resolve(here, "../fixtures/gitignore-globstar");
const negationRoot = path.resolve(here, "../fixtures/gitignore-negation");
const nestedRoot = path.resolve(here, "../fixtures/gitignore-nested");

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

describe("anchored & mid-path .gitignore patterns (ama-yhu)", () => {
  const rules = loadIgnoreRules(anchoredRoot);

  it("anchors a leading-slash pattern to the root, not any depth", () => {
    // `/cache` and `/root-only.ts` ignore the root entry only…
    expect(isIgnoredPath("cache/c.ts", rules)).toBe(true);
    expect(isIgnoredPath("root-only.ts", rules)).toBe(true);
    // …NOT a same-named entry nested deeper (the over-ignoring a stripped leading
    // slash used to cause — index more, never less).
    expect(isIgnoredPath("sub/cache/d.ts", rules)).toBe(false);
    expect(isIgnoredPath("sub/root-only.ts", rules)).toBe(false);
  });

  it("matches an embedded-path pattern relative to the root", () => {
    // `pkg/internal` is anchored by its embedded slash — root-relative only.
    expect(isIgnoredPath("pkg/internal/e.ts", rules)).toBe(true);
    expect(isIgnoredPath("other/pkg/internal/f.ts", rules)).toBe(false);
  });

  it("excludes only the anchored matches from the index", async () => {
    const { store } = await createDefaultIndexer().index(anchoredRoot);
    // kept: the control, and every same-named entry that isn't at the anchor
    expect(store.getNode(fileId("keep.ts"))).toBeDefined();
    expect(store.getNode(fileId("sub/cache/d.ts"))).toBeDefined();
    expect(store.getNode(fileId("sub/root-only.ts"))).toBeDefined();
    expect(store.getNode(fileId("other/pkg/internal/f.ts"))).toBeDefined();
    // dropped: the root-anchored and embedded-path matches
    expect(store.getNode(fileId("cache/c.ts"))).toBeUndefined();
    expect(store.getNode(fileId("root-only.ts"))).toBeUndefined();
    expect(store.getNode(fileId("pkg/internal/e.ts"))).toBeUndefined();
  });
});

describe("`**` deep globs in .gitignore (ama-dd9)", () => {
  const rules = loadIgnoreRules(globstarRoot);

  it("matches `**/x` at any depth, `dir/**` everything under, and `a/**/b` across dirs", () => {
    // `**/*.gen.ts` — any depth, including the root
    expect(isIgnoredPath("root.gen.ts", rules)).toBe(true);
    expect(isIgnoredPath("deep/thing.gen.ts", rules)).toBe(true);
    expect(isIgnoredPath("deep/keep.ts", rules)).toBe(false);
    // `pkg/**` — everything under pkg, at any depth
    expect(isIgnoredPath("pkg/b.ts", rules)).toBe(true);
    expect(isIgnoredPath("pkg/sub/c.ts", rules)).toBe(true);
    // `a/**/z` — a `z` segment under `a` across zero+ directories
    expect(isIgnoredPath("a/p/z/inside.ts", rules)).toBe(true);
    expect(isIgnoredPath("a/p/keep.ts", rules)).toBe(false);
  });

  it("excludes only the `**`-matched files from the index", async () => {
    const { store } = await createDefaultIndexer().index(globstarRoot);
    expect(store.getNode(fileId("keep.ts"))).toBeDefined();
    expect(store.getNode(fileId("deep/keep.ts"))).toBeDefined();
    expect(store.getNode(fileId("a/p/keep.ts"))).toBeDefined();
    expect(store.getNode(fileId("root.gen.ts"))).toBeUndefined();
    expect(store.getNode(fileId("deep/thing.gen.ts"))).toBeUndefined();
    expect(store.getNode(fileId("pkg/b.ts"))).toBeUndefined();
    expect(store.getNode(fileId("pkg/sub/c.ts"))).toBeUndefined();
    expect(store.getNode(fileId("a/p/z/inside.ts"))).toBeUndefined();
  });
});

describe("`!` negations re-include an excluded file (ama-d28)", () => {
  const rules = loadIgnoreRules(negationRoot);

  it("re-includes a file a later `!` rescues from an earlier ignore", () => {
    // `*.gen.ts` excludes, `!keep.gen.ts` rescues
    expect(isIgnoredPath("a.gen.ts", rules)).toBe(true);
    expect(isIgnoredPath("keep.gen.ts", rules)).toBe(false);
    // an anchored ignore + anchored negation
    expect(isIgnoredPath("sub/x.tmp.ts", rules)).toBe(true);
    expect(isIgnoredPath("sub/important.tmp.ts", rules)).toBe(false);
  });

  it("keeps the negated files in the index, drops the rest", async () => {
    const { store } = await createDefaultIndexer().index(negationRoot);
    // kept: the negated files and the control
    expect(store.getNode(fileId("keep.gen.ts"))).toBeDefined();
    expect(store.getNode(fileId("sub/important.tmp.ts"))).toBeDefined();
    expect(store.getNode(fileId("normal.ts"))).toBeDefined();
    // dropped: the un-negated ignores
    expect(store.getNode(fileId("a.gen.ts"))).toBeUndefined();
    expect(store.getNode(fileId("sub/x.tmp.ts"))).toBeUndefined();
  });
});

describe("nested .gitignore files apply per-directory (ama-pyk)", () => {
  it("excludes only the files a directory's own .gitignore covers, dir-relative", async () => {
    const { store } = await createDefaultIndexer().index(nestedRoot);
    // kept: controls + the root .gitignore still works
    expect(store.getNode(fileId("keep.ts"))).toBeDefined();
    expect(store.getNode(fileId("pkg/keep.ts"))).toBeDefined();
    expect(store.getNode(fileId("root-only.ts"))).toBeUndefined();
    // pkg/.gitignore: a bare name ignores at any depth under pkg…
    expect(store.getNode(fileId("pkg/secret.ts"))).toBeUndefined();
    expect(store.getNode(fileId("pkg/sub/secret.ts"))).toBeUndefined();
    // …a glob too…
    expect(store.getNode(fileId("pkg/data.tmp.ts"))).toBeUndefined();
    // …and an anchored `/anchored.ts` is relative to pkg, so it hits pkg/anchored.ts
    expect(store.getNode(fileId("pkg/anchored.ts"))).toBeUndefined();
    // …but NOT pkg/sub/anchored.ts (anchored = pkg root only, not any depth)
    expect(store.getNode(fileId("pkg/sub/anchored.ts"))).toBeDefined();
  });
});
