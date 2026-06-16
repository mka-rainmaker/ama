import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AmaSession } from "../../src/mcp/session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/mini-repo");
const pkg = JSON.parse(fs.readFileSync(path.resolve(here, "../../package.json"), "utf8")) as {
  version: string;
};

describe("AmaSession", () => {
  it("reports not-indexed before any index_repository call", () => {
    const session = new AmaSession();
    const status = session.indexStatus();
    expect(status.indexed).toBe(false);
    // The build stamp rides along even when nothing is indexed.
    expect(status.server.version).toBe(pkg.version);
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

  it("stamps the running server's version and git revision on index_status", async () => {
    const session = new AmaSession();
    // The stamp is present even before anything is indexed — freshness is
    // independent of the index, so Step 0 can check it without a prior index.
    const before = session.indexStatus();
    expect(before.server.version).toBe(pkg.version);

    await session.indexRepository(root);
    const after = session.indexStatus();
    expect(after.server.version).toBe(pkg.version);
    // A git checkout yields a 40-hex SHA captured at server start; null only
    // when the server runs outside a git repo.
    const rev = after.server.revision;
    expect(rev === null || /^[0-9a-f]{40}$/.test(rev)).toBe(true);
  });
});
