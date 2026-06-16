import { describe, expect, it } from "vitest";
import { fileId, symbolId } from "../../src/graph/id.js";

describe("symbolId", () => {
  it("is deterministic for the same symbol", () => {
    expect(symbolId({ file: "src/a.ts", qualifiedName: "foo" })).toBe(
      symbolId({ file: "src/a.ts", qualifiedName: "foo" }),
    );
  });

  it("differs by qualified name within the same file", () => {
    expect(symbolId({ file: "src/a.ts", qualifiedName: "foo" })).not.toBe(
      symbolId({ file: "src/a.ts", qualifiedName: "bar" }),
    );
  });

  it("differs by file for the same name", () => {
    expect(symbolId({ file: "src/a.ts", qualifiedName: "foo" })).not.toBe(
      symbolId({ file: "src/b.ts", qualifiedName: "foo" }),
    );
  });

  it("is location-independent: identical inputs ignore where the symbol sits in the file", () => {
    // The API intentionally takes no line/column — moving a symbol within a
    // file must not change its id. Same (file, qualifiedName) => same id.
    const before = symbolId({ file: "src/a.ts", qualifiedName: "Cls.method" });
    const after = symbolId({ file: "src/a.ts", qualifiedName: "Cls.method" });
    expect(after).toBe(before);
  });
});

describe("fileId", () => {
  it("uses the repo-relative path as a stable file node id", () => {
    expect(fileId("src/a.ts")).toBe(fileId("src/a.ts"));
    expect(fileId("src/a.ts")).not.toBe(fileId("src/b.ts"));
  });
});
