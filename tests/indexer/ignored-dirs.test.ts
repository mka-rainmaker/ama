import { describe, expect, it } from "vitest";
import { isIgnoredSegment } from "../../src/indexer/ignore.js";

/**
 * Indexing a parent-of-repos workspace pulled in vendored deps + caches as duplicate/noisy
 * paths (battle-test feedback, ama-65z). Dot-dirs (`.venv`, `.git`) are skipped by the
 * leading-dot rule; the non-dot vendor/build/cache dirs must be in IGNORED_DIRS. */
describe("built-in ignored dirs cover non-dot vendor/build/cache dirs (ama-65z)", () => {
  it("ignores non-dot vendored/build/cache dirs", () => {
    for (const d of [
      "node_modules",
      "venv",
      "__pycache__",
      "site-packages",
      "target",
      "vendor",
      "dist",
      "build",
      "coverage",
    ]) {
      expect(isIgnoredSegment(d)).toBe(true);
    }
  });

  it("ignores dot-dirs via the leading-dot rule", () => {
    expect(isIgnoredSegment(".venv")).toBe(true);
    expect(isIgnoredSegment(".git")).toBe(true);
  });

  it("does not over-ignore real source dirs", () => {
    for (const d of ["src", "app", "lib", "tests", "review-service", "handlers"]) {
      expect(isIgnoredSegment(d)).toBe(false);
    }
  });
});
