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
 * returned nothing. Each such read adds a References edge from the enclosing method to
 * the property (ama-qo3), and the same now holds for cross-instance `obj.<prop>` reads
 * (ama-emb), so find_referrers answers "who uses this member" across the codebase.
 */
describe("TypeScriptAnalyzer property references (ama-qo3, ama-emb)", () => {
  const result = new TypeScriptAnalyzer().analyze(root, ["box.ts"]);
  const referrersTo = (to: string) =>
    result.edges.filter((e) => e.kind === "References" && e.to === to).map((e) => e.from);

  it("emits a References edge from each method that reads this.<prop> (ama-qo3)", () => {
    expect(referrersTo(sym("Box.value"))).toContain(sym("Box.read"));
    expect(referrersTo(sym("Box.value"))).toContain(sym("Box.double"));
  });

  it("tracks cross-instance obj.<prop> reads too, not just this.<prop> (ama-emb)", () => {
    // `other.value` inside compare() — a cross-instance read of a member.
    expect(referrersTo(sym("Box.value"))).toContain(sym("Box.compare"));
    // `b.size` inside the free function widen() — obj.<prop> from outside any class.
    expect(referrersTo(sym("Box.size"))).toContain(sym("widen"));
  });

  it("tracks destructuring reads of a property, like obj.<prop> (ama-eda)", () => {
    // `function dims({ size }: Box)` reads Box.size by destructuring — the same member
    // read as `b.size`, so it should be a referrer too.
    expect(referrersTo(sym("Box.size"))).toContain(sym("dims"));
  });
});
