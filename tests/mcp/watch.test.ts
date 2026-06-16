import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WatchSource } from "../../src/indexer/watcher.js";
import { AmaSession } from "../../src/mcp/session.js";

// End-to-end auto-sync: a file watcher + debounce + reindexFile. Change events
// are injected through a synchronous WatchSource so the test never waits on OS
// file-event latency (the old source of flakes); only the small debounce window
// is a real timer, and it fires deterministically. We still write real files so
// the watcher's stat check sees them.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A WatchSource whose change events the test fires by hand. */
function manualSource(): { source: WatchSource; fire: (rel: string) => void } {
  let emit: ((rel: string) => void) | undefined;
  return {
    source: (_root, onEvent) => {
      emit = onEvent;
      return {
        close() {
          emit = undefined;
        },
      };
    },
    fire: (rel) => emit?.(rel),
  };
}

describe("AmaSession auto-sync (watch)", () => {
  let dir: string;
  let session: AmaSession;
  let fire: (rel: string) => void;

  const write = (rel: string, body: string) => fs.writeFileSync(path.join(dir, rel), body);
  const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (cond()) return;
      await delay(10);
    }
    throw new Error(`condition not met within ${ms}ms`);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-watch-session-"));
    write("a.ts", "export function existing(): void {}\n");
    session = new AmaSession();
    await session.indexRepository(dir);
    const manual = manualSource();
    fire = manual.fire;
    session.watch({ windowMs: 30, source: manual.source });
  });

  afterEach(async () => {
    await session.unwatch();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-indexes a file automatically after it is edited on disk", async () => {
    expect(session.searchSymbol("freshSymbol")).toEqual([]);
    write("a.ts", "export function existing(): void {}\nexport function freshSymbol(): void {}\n");
    fire("a.ts");
    await until(() => session.searchSymbol("freshSymbol").some((n) => n.kind === "Function"));
  });

  it("picks up a brand-new file automatically", async () => {
    write("b.ts", "export function inNewFile(): void {}\n");
    fire("b.ts");
    await until(() => session.searchSymbol("inNewFile").some((n) => n.kind === "Function"));
  });
});
