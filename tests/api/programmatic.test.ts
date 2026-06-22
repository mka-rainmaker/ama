import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ama, type AmaSession, index } from "../../src/api.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/api-demo");

/**
 * The programmatic API: `index(repo)` returns a transport-free session whose query surface
 * (searchSymbol/findCallers/impactAnalysis/…) is callable from code — Ama embedded as a
 * library, not only run as an MCP server/CLI. (ama-dah) */
describe("programmatic API (ama-dah)", () => {
  let ama: AmaSession;
  beforeAll(async () => {
    ama = await index(root);
  });
  afterAll(() => ama.close());

  it("index() returns a ready Ama session", () => {
    expect(ama).toBeInstanceOf(Ama);
    expect(ama.indexStatus().indexed).toBe(true);
  });

  it("exposes the query surface — searchSymbol + findCallers", () => {
    expect(ama.searchSymbol("greet").some((n) => n.name === "greet")).toBe(true);
    // main() calls greet(), so greet has a caller.
    expect(ama.findCallers("greet").length).toBeGreaterThan(0);
  });
});
