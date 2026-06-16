import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AmaSession } from "../../src/mcp/session.js";

// End-to-end auto-sync: a real file watcher + debounce + reindexFile, driven by
// editing files on disk. Real timers here (unlike the Debouncer unit test), so
// poll until the graph reflects the change rather than asserting synchronously.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AmaSession auto-sync (watch)", () => {
  let dir: string;
  let session: AmaSession;

  const write = (rel: string, body: string) => fs.writeFileSync(path.join(dir, rel), body);
  const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (cond()) return;
      await delay(25);
    }
    throw new Error(`condition not met within ${ms}ms`);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-watch-session-"));
    write("a.ts", "export function existing(): void {}\n");
    session = new AmaSession();
    await session.indexRepository(dir);
    session.watch({ windowMs: 30 });
    await delay(100); // let the watch become active
  });

  afterEach(async () => {
    await session.unwatch();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-indexes a file automatically after it is edited on disk", async () => {
    expect(session.searchSymbol("freshSymbol")).toEqual([]);
    write("a.ts", "export function existing(): void {}\nexport function freshSymbol(): void {}\n");
    await until(() => session.searchSymbol("freshSymbol").some((n) => n.kind === "Function"));
  });

  it("picks up a brand-new file automatically", async () => {
    write("b.ts", "export function inNewFile(): void {}\n");
    await until(() => session.searchSymbol("inNewFile").some((n) => n.kind === "Function"));
  });
});
