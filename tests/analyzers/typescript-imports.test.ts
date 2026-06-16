import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { fileId, symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-imports");
const lib = (qualifiedName: string) => symbolId({ file: "lib.ts", qualifiedName });

describe("TypeScriptAnalyzer imports resolution", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, [
      "lib.ts",
      "barrel.ts",
      "main.ts",
      "ns-barrel.ts",
    ]);
  });

  const importsEdges = () => result.edges.filter((e) => e.kind === "Imports");

  it("links an importing file to a named symbol it imports", () => {
    expect(importsEdges().some((e) => e.from === fileId("main.ts") && e.to === lib("Widget"))).toBe(
      true,
    );
  });

  it("links an importing file to a default import", () => {
    expect(
      importsEdges().some((e) => e.from === fileId("main.ts") && e.to === lib("makeDefault")),
    ).toBe(true);
  });

  it("emits an Imports edge for a re-export, resolved to the original declaration", () => {
    // `barrel.ts` does `export { greet } from "./lib.js"` — the target is
    // greet's real home in lib.ts, not the barrel.
    expect(
      importsEdges().some((e) => e.from === fileId("barrel.ts") && e.to === lib("greet")),
    ).toBe(true);
  });

  it("resolves an import through a re-export chain to the original declaration", () => {
    // main imports `greet` via the barrel; it must still resolve to lib.ts.
    expect(importsEdges().some((e) => e.from === fileId("main.ts") && e.to === lib("greet"))).toBe(
      true,
    );
  });

  it("links a namespace import to the imported module's File node", () => {
    // main.ts: `import * as lib from "./lib.js"` aliases the whole module,
    // so the edge targets lib.ts's File node, not any single declaration.
    expect(
      importsEdges().some((e) => e.from === fileId("main.ts") && e.to === fileId("lib.ts")),
    ).toBe(true);
  });

  it("links a star re-export to the re-exported module's File node", () => {
    // barrel.ts: `export * from "./lib.js"` has no named clause to resolve,
    // so the edge targets lib.ts's File node.
    expect(
      importsEdges().some((e) => e.from === fileId("barrel.ts") && e.to === fileId("lib.ts")),
    ).toBe(true);
  });

  it("links a namespace re-export to the re-exported module's File node", () => {
    // ns-barrel.ts: `export * as lib from "./lib.js"` aliases the whole module.
    expect(
      importsEdges().some((e) => e.from === fileId("ns-barrel.ts") && e.to === fileId("lib.ts")),
    ).toBe(true);
  });

  it("does not emit Imports edges from a file that imports nothing", () => {
    expect(importsEdges().some((e) => e.from === fileId("lib.ts"))).toBe(false);
  });
});
