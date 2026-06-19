import { describe, expect, it } from "vitest";
import { resultHint } from "../../src/mcp/server.js";

const block = (text: string) => ({ type: "text" as const, text });

// reply() builds content as [banner?, data, hint?] — a staleness banner is
// unshifted (first), an advisory low-confidence hint is pushed (last), and the
// JSON data block sits between. resultHint must read staleness from the banner,
// not the block count (which a trailing hint also inflates). (ama-zk6)
describe("resultHint", () => {
  it("does NOT label a trailing low-confidence hint as stale", () => {
    const result = { content: [block(JSON.stringify([{ id: "x" }])), block("⚐ weak match")] };
    expect(resultHint(result)).toBe("1 result");
  });

  it("labels a prepended staleness banner as stale", () => {
    const result = {
      content: [block("⚠ stale"), block(JSON.stringify([{ id: "x" }, { id: "y" }]))],
    };
    expect(resultHint(result)).toBe("stale, 2 results");
  });

  it("with both banner and trailing hint, reads the data block and stays stale", () => {
    const result = {
      content: [block("⚠ stale"), block(JSON.stringify([])), block("⚐ weak")],
    };
    expect(resultHint(result)).toBe("stale, 0 results");
  });

  it("summarizes plain JSON with no banner or hint", () => {
    const result = { content: [block(JSON.stringify({ nodeCount: 5, edgeCount: 7 }))] };
    expect(resultHint(result)).toBe("5 nodes, 7 edges");
  });
});
