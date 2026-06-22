import { describe, expect, it } from "vitest";
import { isIgnoredSegment } from "../../src/indexer/ignore.js";

/**
 * Indexing a parent-of-repos workspace pulled in vendored deps + caches as duplicate/noisy paths
 * (battle-test feedback, ama-65z). The fix hardcodes only *universally* non-source dirs; project-
 * specific build/vendor dirs (`target`, `vendor`, `venv`) are legitimate source dirs in some
 * projects, so they're left to the project's `.gitignore` (root + nested) rather than blanket-
 * ignored — this set isn't negation-overridable. */
describe("built-in ignored dirs (ama-65z)", () => {
  it("ignores universally non-source dirs (deps / bytecode / build output)", () => {
    for (const d of ["node_modules", "__pycache__", "site-packages", "dist", "build", "coverage"]) {
      expect(isIgnoredSegment(d)).toBe(true);
    }
  });

  it("ignores dot-dirs (.venv, .git) via the leading-dot rule", () => {
    expect(isIgnoredSegment(".venv")).toBe(true);
    expect(isIgnoredSegment(".git")).toBe(true);
  });

  it("does NOT hardcode ambiguous names — they're legit source dirs in some projects, so .gitignore decides", () => {
    for (const d of ["vendor", "target", "venv"]) {
      expect(isIgnoredSegment(d)).toBe(false);
    }
  });

  it("does not over-ignore real source dirs", () => {
    for (const d of ["src", "app", "lib", "tests", "review-service", "handlers"]) {
      expect(isIgnoredSegment(d)).toBe(false);
    }
  });
});
