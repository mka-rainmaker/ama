import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WatchSource } from "../../src/indexer/watcher.js";
import { createServer } from "../../src/mcp/server.js";
import { AmaSession } from "../../src/mcp/session.js";

// Staleness banners (ama-gd5.5): while the auto-syncer has edits queued in its
// debounce window, query results don't yet reflect them, so responses must
// prepend a warning naming the pending files and suggesting a direct read.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A WatchSource whose change events the test fires by hand — no OS latency. */
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

describe("staleness banner", () => {
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-stale-"));
    write("a.ts", "export function findme(): void {}\n");
    session = new AmaSession();
    await session.indexRepository(dir);
  });

  afterEach(() => {
    session.unwatch();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("has no banner when nothing is pending", () => {
    expect(session.stalenessBanner()).toBeUndefined();
  });

  it("names the pending files and suggests a direct read during the window", async () => {
    const { source, fire } = manualSource();
    session.watch({ windowMs: 10000, source }); // long window: edits stay pending
    write("a.ts", "export function findme(): void {}\nexport function later(): void {}\n");
    fire("a.ts");
    await until(() => session.indexStatus().pendingSync > 0);

    const banner = session.stalenessBanner();
    expect(banner).toBeDefined();
    expect(banner).toContain("a.ts");
    expect(banner).toMatch(/read .*directly/i);
  });

  it("prepends the banner before the JSON on a query tool response", async () => {
    const { source, fire } = manualSource();
    session.watch({ windowMs: 10000, source });
    write("a.ts", "export function findme(): void {}\nexport function later(): void {}\n");
    fire("a.ts");
    await until(() => session.indexStatus().pendingSync > 0);

    const server = createServer(session);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = (await client.callTool({
      name: "search_symbol",
      arguments: { query: "findme" },
    })) as { content: Array<{ type: string; text: string }> };

    expect(result.content).toHaveLength(2);
    expect(result.content[0]?.text).toMatch(/pending/i); // banner first
    expect(result.content[0]?.text).toContain("a.ts");
    const data = JSON.parse(result.content[1]?.text ?? "null"); // JSON second
    expect(Array.isArray(data)).toBe(true);
  });
});
