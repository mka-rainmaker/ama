import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AmaSession } from "../../src/mcp/session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projA = path.resolve(here, "../fixtures/xproj-a");
const projB = path.resolve(here, "../fixtures/xproj-b");

/**
 * One session can hold several indexed projects at once. index_repository is additive
 * (a new root is kept alongside the others), and a `projectPath` routes a query to a
 * specific project; without it, queries hit the primary (last-indexed). (ama-ont)
 */
describe("cross-project queries (ama-ont)", () => {
  let session: AmaSession;
  beforeEach(async () => {
    session = new AmaSession();
    await session.indexRepository(projA); // A
    await session.indexRepository(projB); // B is now primary
  });
  afterEach(() => session.close());

  it("routes a query to the project named by projectPath", () => {
    // alpha lives only in A; beta only in B.
    expect(session.searchSymbol("alpha", undefined, projA).map((n) => n.name)).toContain("alpha");
    expect(session.node("alpha", projA)?.node.name).toBe("alpha");
  });

  it("uses the primary (last-indexed) project when no projectPath is given", () => {
    expect(session.searchSymbol("beta").map((n) => n.name)).toContain("beta");
    // A's symbol is not visible from the primary without naming A.
    expect(session.searchSymbol("alpha").map((n) => n.name)).not.toContain("alpha");
  });

  it("keeps every indexed project queryable (index is additive)", () => {
    expect(session.searchSymbol("beta", undefined, projB).map((n) => n.name)).toContain("beta");
    expect(session.searchSymbol("alpha", undefined, projA).map((n) => n.name)).toContain("alpha");
  });

  it("lists all indexed projects in index_status", () => {
    const status = session.indexStatus();
    if (!status.indexed) throw new Error("expected indexed");
    expect(status.projects.map((p) => p.root).sort()).toEqual([projA, projB].sort());
  });

  it("errors clearly for a path that names no indexed project", () => {
    expect(() => session.searchSymbol("alpha", undefined, "/no/such/project")).toThrow(
      /No indexed project/,
    );
  });
});
