import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/mcp/server.js";
import { AmaSession } from "../../src/mcp/session.js";

// Connect-time catch-up (ama-gd5.4): on MCP reconnect, reconcile files that
// changed while disconnected before serving the first query.
describe("connect-time catch-up", () => {
  let dir: string;
  let session: AmaSession;
  const write = (rel: string, body: string) => fs.writeFileSync(path.join(dir, rel), body);

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-catchup-"));
    write("a.ts", "export function original(): void {}\n");
    session = new AmaSession();
    await session.indexRepository(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("catchUpIfNeeded is a no-op until armed", async () => {
    expect(await session.catchUpIfNeeded()).toBeUndefined();
  });

  it("reconciles on-disk edits once after being armed, then disarms", async () => {
    write("a.ts", "export function original(): void {}\nexport function arrived(): void {}\n");
    session.markForCatchUp();

    const result = await session.catchUpIfNeeded();
    expect(result?.changed).toContain("a.ts");
    expect(session.searchSymbol("arrived").some((n) => n.kind === "Function")).toBe(true);
    // The arm is one-shot.
    expect(await session.catchUpIfNeeded()).toBeUndefined();
  });

  it("does not arm before anything is indexed", async () => {
    const fresh = new AmaSession();
    fresh.markForCatchUp();
    expect(await fresh.catchUpIfNeeded()).toBeUndefined();
  });

  it("a fresh index clears a pending catch-up", async () => {
    session.markForCatchUp();
    await session.indexRepository(dir);
    expect(await session.catchUpIfNeeded()).toBeUndefined();
  });

  it("catches up before the first query after a reconnect (over MCP)", async () => {
    const server = createServer(session);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // A file changes while the client is away, then the client reconnects: the
    // SDK fires the server's `oninitialized` on the initialize handshake.
    write(
      "a.ts",
      "export function original(): void {}\nexport function afterReconnect(): void {}\n",
    );
    server.server.oninitialized?.();

    const result = (await client.callTool({
      name: "search_symbol",
      arguments: { query: "afterReconnect" },
    })) as { content: Array<{ type: string; text: string }> };
    const hits = JSON.parse(result.content[0]?.text ?? "null");
    expect(hits.map((n: { name: string }) => n.name)).toContain("afterReconnect");
  });
});
