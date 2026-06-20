import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { fileId, symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-toplevel-calls");
const sym = (qualifiedName: string) => symbolId({ file: "mod.ts", qualifiedName });

/**
 * A call at module top-level has no enclosing function, so the deep analyzer used
 * to drop it (the `&& enclosingId` guard) — find_callers(setup) missed the bare
 * `setup()` statement. Seeding collectCalls with the File id makes the File the
 * fallback caller, so module-init / entry-block wiring is queryable, consistent
 * with how Defines/Imports edges already originate at the File node. (ama-53q)
 */
describe("TypeScriptAnalyzer top-level call attribution (ama-53q)", () => {
  const result = new TypeScriptAnalyzer().analyze(root, ["mod.ts"]);
  const callsToSetup = result.edges.filter((e) => e.kind === "Calls" && e.to === sym("setup"));

  it("attributes a module-level call to the File node", () => {
    expect(callsToSetup.some((e) => e.from === fileId("mod.ts"))).toBe(true);
  });

  it("still attributes an in-function call to that function, not the File", () => {
    expect(callsToSetup.some((e) => e.from === sym("caller"))).toBe(true);
    // the in-function call must NOT also leak to the File (only the top-level one does)
    const fromFile = callsToSetup.filter((e) => e.from === fileId("mod.ts"));
    expect(fromFile.length).toBe(1);
  });

  it("does NOT leak a call nested inside a top-level callback to the File", () => {
    // `nested()` is called inside withCallback's arrow — not file scope — so it
    // must not appear as a File-originated call (that would make every test file
    // 'call' it/expect/describe). Only genuinely top-level calls reach the File.
    const callsToNested = result.edges.filter((e) => e.kind === "Calls" && e.to === sym("nested"));
    expect(callsToNested.some((e) => e.from === fileId("mod.ts"))).toBe(false);
  });
});
