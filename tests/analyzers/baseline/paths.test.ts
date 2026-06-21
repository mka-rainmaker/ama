import { describe, expect, it } from "vitest";
import { ancestorDirs } from "../../../src/analyzers/baseline/paths.js";

/**
 * Shared ancestor-walk for the baseline import resolvers (Java/C#/Kotlin), extracted
 * from the duplicated copies. Lists a file's ancestor directories, closest first,
 * ending at the repo root (""). (ama-mgn)
 */
describe("ancestorDirs (ama-mgn)", () => {
  it("lists ancestor directories closest-first, ending at the repo root", () => {
    expect(ancestorDirs("a/b/c.ts")).toEqual(["a/b", "a", ""]);
  });

  it("returns just the root for a top-level file", () => {
    expect(ancestorDirs("main.go")).toEqual([""]);
  });
});
