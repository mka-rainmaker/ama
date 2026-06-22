import { describe, expect, it } from "vitest";
import { isSqliteExperimentalWarning } from "../../src/runtime/quiet-sqlite-warning.js";

/**
 * The filter must swallow ONLY node:sqlite's "experimental feature" notice — the one Ama
 * triggers deliberately by using node:sqlite as its store backend — and leave every other
 * warning (other experimentals, deprecations) intact. (ama-hee)
 */
describe("isSqliteExperimentalWarning (ama-hee)", () => {
  it("matches the node:sqlite experimental notice", () => {
    expect(
      isSqliteExperimentalWarning(
        "ExperimentalWarning",
        "SQLite is an experimental feature and might change at any time",
      ),
    ).toBe(true);
  });

  it("leaves other experimental warnings alone", () => {
    expect(isSqliteExperimentalWarning("ExperimentalWarning", "VM Modules is experimental")).toBe(
      false,
    );
  });

  it("leaves non-experimental warnings (and empty input) alone", () => {
    expect(isSqliteExperimentalWarning("DeprecationWarning", "SQLite thing deprecated")).toBe(
      false,
    );
    expect(isSqliteExperimentalWarning(undefined, undefined)).toBe(false);
  });
});
