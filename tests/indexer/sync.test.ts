import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AmaSession } from "../../src/mcp/session.js";

// Manual catch-up sync (ama-gd5.6): reconcile files that changed on disk since
// the last index, without relying on a live watcher. Detection is fingerprint
// based (size + mtime, hash as tiebreaker), reusing reindexFile per change.
describe("AmaSession.sync (manual catch-up)", () => {
  let dir: string;
  let session: AmaSession;
  const write = (rel: string, body: string) => fs.writeFileSync(path.join(dir, rel), body);

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-sync-"));
    write("a.ts", "export function alpha(): void {}\n");
    write("b.ts", "export function beta(): void {}\n");
    session = new AmaSession();
    await session.indexRepository(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("syncs nothing when the tree is unchanged", async () => {
    const result = await session.sync();
    expect(result.changed).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("re-indexes a file modified on disk", async () => {
    write("b.ts", "export function beta(): void {}\nexport function addedByEdit(): void {}\n");
    const result = await session.sync();
    expect(result.changed).toContain("b.ts");
    expect(session.searchSymbol("addedByEdit").some((n) => n.kind === "Function")).toBe(true);
  });

  it("indexes a brand-new file", async () => {
    write("c.ts", "export function gamma(): void {}\n");
    const result = await session.sync();
    expect(result.changed).toContain("c.ts");
    expect(session.searchSymbol("gamma").some((n) => n.kind === "Function")).toBe(true);
  });

  it("drops a file deleted from disk", async () => {
    fs.rmSync(path.join(dir, "a.ts"));
    const result = await session.sync();
    expect(result.removed).toContain("a.ts");
    expect(session.searchSymbol("alpha").filter((n) => n.kind === "Function")).toEqual([]);
  });

  it("reports pendingSync = 0 in status when not watching", () => {
    expect(session.indexStatus()).toMatchObject({ indexed: true, pendingSync: 0 });
  });
});
