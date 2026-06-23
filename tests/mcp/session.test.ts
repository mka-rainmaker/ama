import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";
import { AmaSession } from "../../src/mcp/session.js";
import { InMemoryStore } from "../../src/store/memory.js";

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

  it("auto-indexes a configured default root on ensureIndexed (transparent first index, #35)", async () => {
    const session = new AmaSession(createDefaultIndexer(), root);
    expect(session.indexStatus().indexed).toBe(false);
    await session.ensureIndexed();
    expect(session.indexStatus().indexed).toBe(true);
    expect(() => session.searchSymbol("add")).not.toThrow();
  });

  it("ensureIndexed is a no-op without a default root (explicit-index contract preserved, #35)", async () => {
    const session = new AmaSession();
    await session.ensureIndexed();
    expect(session.indexStatus().indexed).toBe(false);
    expect(() => session.searchSymbol("add")).toThrow(/index_repository/);
  });

  it("rejects a non-directory path with a clear error, not a raw ENOTDIR", async () => {
    const session = new AmaSession();
    const file = path.resolve(here, "../fixtures/ts-calls/calls.ts");
    await expect(session.indexRepository(file)).rejects.toThrow(/^Not a directory/);
  });

  it("leaves the existing index intact when a re-index fails", async () => {
    // A shared store mimics a persistent (file-backed) store reused across
    // indexes — the case where clearing before a failing walk corrupts the index.
    const shared = new InMemoryStore();
    const session = new AmaSession(createDefaultIndexer(() => shared));
    const callsDir = path.resolve(here, "../fixtures/ts-calls");
    await session.indexRepository(callsDir);
    expect(session.searchSymbol("helper").map((n) => n.name)).toContain("helper");

    // Indexing a non-directory (a file) must fail WITHOUT wiping the prior index.
    await expect(session.indexRepository(path.join(callsDir, "calls.ts"))).rejects.toThrow();
    expect(session.searchSymbol("helper").map((n) => n.name)).toContain("helper");
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
