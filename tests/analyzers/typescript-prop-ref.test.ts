import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-prop-ref");
const sym = (qualifiedName: string) => symbolId({ file: "box.ts", qualifiedName });

/**
 * A `this.<prop>` read is how a class uses its own fields/parameter properties, but
 * the member side of a property access was skipped — so find_referrers on a property
 * returned nothing. Each such read should add a References edge from the enclosing
 * method to the property. (ama-qo3)
 */
describe("TypeScriptAnalyzer this.<prop> references (ama-qo3)", () => {
  const result = new TypeScriptAnalyzer().analyze(root, ["box.ts"]);
  const refsToValue = result.edges.filter(
    (e) => e.kind === "References" && e.to === sym("Box.value"),
  );
  const referrers = refsToValue.map((e) => e.from);

  it("emits a References edge from each method that reads the property", () => {
    expect(referrers).toContain(sym("Box.read"));
    expect(referrers).toContain(sym("Box.double"));
  });
});
