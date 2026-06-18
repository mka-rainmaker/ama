import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-resolution");

describe("TypeScriptAnalyzer resolution-coverage counts (ama-m8k.12)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new TypeScriptAnalyzer().analyze(root, ["res.ts"]);
  });

  it("counts every call/construction site that has an enclosing function", () => {
    // main() calls helper() (internal) and console.log() (external).
    expect(result.resolution?.callsTotal).toBe(2);
  });

  it("counts only the sites that resolve to a known node", () => {
    // helper() resolves to a node; console.log() does not (no node for it).
    expect(result.resolution?.callsResolved).toBe(1);
  });

  it("reports which unresolved calls there were, grouped by callee root (ama-qbn)", () => {
    // console.log() is the only unresolved call; its root is `console`.
    expect(result.resolution?.unresolved).toEqual({ console: 1 });
  });

  it("groups an unresolved this.prop.method() call by the property, not `this` (ama-k9t)", async () => {
    const r = await new TypeScriptAnalyzer().analyze(root, ["this-calls.ts"]);
    // this.items.push() is an unresolved builtin call; group it under `items`, not
    // the opaque `this`, so the breakdown locates where unresolved calls cluster.
    expect(r.resolution?.unresolved).toEqual({ items: 1 });
  });
});
