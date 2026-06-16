import { describe, expect, it } from "vitest";
import { AnalyzerRegistry } from "../../src/analyzers/registry.js";
import type { Analyzer } from "../../src/analyzers/types.js";

const fakeTs: Analyzer = {
  language: "typescript",
  tier: "deep",
  extensions: [".ts", ".tsx"],
  analyze: () => ({ nodes: [], edges: [] }),
};

describe("AnalyzerRegistry", () => {
  it("selects an analyzer by file extension", () => {
    const reg = new AnalyzerRegistry();
    reg.register(fakeTs);
    expect(reg.forFile("src/a.ts")).toBe(fakeTs);
    expect(reg.forFile("src/components/b.tsx")).toBe(fakeTs);
  });

  it("returns undefined for an unhandled extension", () => {
    const reg = new AnalyzerRegistry();
    reg.register(fakeTs);
    expect(reg.forFile("src/a.py")).toBeUndefined();
  });

  it("lists registered analyzers", () => {
    const reg = new AnalyzerRegistry();
    reg.register(fakeTs);
    expect(reg.all()).toEqual([fakeTs]);
  });
});
