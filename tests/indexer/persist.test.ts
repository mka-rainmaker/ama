import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";
import { AmaSession } from "../../src/mcp/session.js";
import { SqliteStore } from "../../src/store/sqlite.js";

// Persistent index (ama-ndw.2): a file-backed SqliteStore lets the index survive
// a process restart. On startup, AmaSession.open() reopens the persisted graph
// instead of re-indexing, then gd5.4 connect-time catch-up reconciles any drift.
describe("persistent index (reopen on restart)", () => {
  let dir: string;
  let db: string;
  const write = (rel: string, body: string) => fs.writeFileSync(path.join(dir, rel), body);
  const fn = (n: { kind: string }) => n.kind === "Function";
  const persistentSession = () => new AmaSession(createDefaultIndexer(() => new SqliteStore(db)));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-persist-"));
    db = path.join(dir, "index.db");
    write("a.ts", "export function persisted(): void {}\n");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reopens a persisted index without re-indexing, then catches up drift", async () => {
    const s1 = persistentSession();
    await s1.indexRepository(dir);
    s1.close(); // "shut down"

    // A file changes while the server is down.
    write(
      "a.ts",
      "export function persisted(): void {}\nexport function afterRestart(): void {}\n",
    );

    const s2 = persistentSession();
    await s2.open(dir);
    // Reopened from disk: the old symbol is present, the new one is not yet —
    // proving open() did not re-scan the tree.
    expect(s2.searchSymbol("persisted").some(fn)).toBe(true);
    expect(s2.searchSymbol("afterRestart").some(fn)).toBe(false);
    // Connect-time catch-up reconciles the drift.
    await s2.catchUpIfNeeded();
    expect(s2.searchSymbol("afterRestart").some(fn)).toBe(true);
    s2.close();
  });

  it("indexes fresh when no persisted index exists", async () => {
    const s = persistentSession();
    await s.open(dir); // empty db → full index
    expect(s.searchSymbol("persisted").some(fn)).toBe(true);
    s.close();
  });

  it("a full re-index clears stale symbols from the persistent store", async () => {
    write("b.ts", "export function removeMe(): void {}\n");
    const s1 = persistentSession();
    await s1.indexRepository(dir);
    expect(s1.searchSymbol("removeMe").some(fn)).toBe(true);
    s1.close();

    fs.rmSync(path.join(dir, "b.ts"));
    const s2 = persistentSession();
    await s2.indexRepository(dir); // full rebuild wipes the old DB first
    expect(s2.searchSymbol("removeMe").filter(fn)).toEqual([]);
    s2.close();
  });

  it("does not reopen an index written by an incompatible schema version", async () => {
    const s1 = persistentSession();
    await s1.indexRepository(dir);
    s1.close();
    // Corrupt the recorded schema version to simulate an older/newer Ama.
    const raw = new SqliteStore(db);
    raw.setMeta("ama:schema", "-1");
    raw.close();

    write("a.ts", "export function persisted(): void {}\nexport function rebuilt(): void {}\n");
    const s2 = persistentSession();
    await s2.open(dir); // mismatch → full re-index, not reopen
    // A re-index reflects the change immediately (no catch-up needed).
    expect(s2.searchSymbol("rebuilt").some(fn)).toBe(true);
    s2.close();
  });
});
