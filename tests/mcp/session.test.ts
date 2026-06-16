import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AmaSession } from "../../src/mcp/session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/mini-repo");

describe("AmaSession", () => {
  it("reports not-indexed before any index_repository call", () => {
    const session = new AmaSession();
    expect(session.indexStatus()).toEqual({ indexed: false });
  });

  it("indexes a repository and then reports status with tier coverage", async () => {
    const session = new AmaSession();
    const stats = await session.indexRepository(root);
    expect(stats.fileCount).toBe(2);

    const status = session.indexStatus();
    expect(status.indexed).toBe(true);
    if (status.indexed) {
      expect(status.fileCount).toBe(2);
      expect(status.nodeCount).toBeGreaterThanOrEqual(4);
      expect(status.languages).toEqual([{ language: "typescript", tier: "deep", files: 2 }]);
    }
  });

  it("throws a helpful error if you query before indexing", () => {
    const session = new AmaSession();
    expect(() => session.searchSymbol("add")).toThrow(/index_repository/);
  });
});
