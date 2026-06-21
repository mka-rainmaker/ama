import { describe, expect, it } from "vitest";
import { capped } from "../../src/mcp/server.js";

/**
 * search_symbol/search_code requested exactly `limit` results and returned a bare
 * list, so a capped result was indistinguishable from the whole answer. The handler
 * now asks for limit+1; capped() slices back to limit and warns when there was more.
 * (ama-b4q)
 */
describe("capped (ama-b4q)", () => {
  it("slices to the limit and warns when more than the limit came back", () => {
    const { shown, hint } = capped([1, 2, 3], 2);
    expect(shown).toEqual([1, 2]);
    expect(hint).toMatch(/first 2/);
    expect(hint).toMatch(/more exist/);
  });

  it("returns everything with no hint when within the limit", () => {
    const { shown, hint } = capped([1, 2], 2);
    expect(shown).toEqual([1, 2]);
    expect(hint).toBeUndefined();
  });

  it("composes a base hint with the truncation hint", () => {
    const { shown, hint } = capped([1, 2, 3], 2, "weak match");
    expect(shown).toEqual([1, 2]);
    expect(hint).toContain("weak match");
    expect(hint).toMatch(/first 2/);
  });
});
