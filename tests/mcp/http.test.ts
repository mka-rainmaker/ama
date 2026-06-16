import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../../src/mcp/http.js";
import { AmaSession } from "../../src/mcp/session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-calls");

function firstText(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0]?.text ?? "";
}

// MCP over Streamable HTTP (ama-ndw.1): the same tools, served by a standalone
// HTTP server the client connects to by URL instead of one it spawns over
// stdio. One AmaSession is shared across client sessions, so the index outlives
// a disconnect/reconnect within the process — the basis for a dev server a
// `tsx watch` restart can bounce.
describe("MCP over HTTP", () => {
  let server: ReturnType<typeof createHttpServer>;
  let url: URL;

  beforeEach(async () => {
    server = createHttpServer(new AmaSession());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function connect(): Promise<Client> {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    return client;
  }

  it("indexes and queries over the Streamable HTTP transport", async () => {
    const client = await connect();
    await client.callTool({ name: "index_repository", arguments: { path: root } });

    const status = JSON.parse(
      firstText(await client.callTool({ name: "index_status", arguments: {} })),
    );
    expect(status.indexed).toBe(true);

    const hits = JSON.parse(
      firstText(await client.callTool({ name: "search_symbol", arguments: { query: "helper" } })),
    );
    expect(hits.map((n: { name: string }) => n.name)).toContain("helper");
    await client.close();
  });

  it("shares one index across reconnects (the session outlives a client)", async () => {
    const c1 = await connect();
    await c1.callTool({ name: "index_repository", arguments: { path: root } });
    await c1.close();

    // A fresh client (new MCP session) reaches the same server + AmaSession, so
    // the graph is already there — no re-index needed.
    const c2 = await connect();
    const hits = JSON.parse(
      firstText(await c2.callTool({ name: "search_symbol", arguments: { query: "helper" } })),
    );
    expect(hits.map((n: { name: string }) => n.name)).toContain("helper");
    await c2.close();
  });

  // A `tsx watch` restart wipes the in-process session map, so the client's old
  // Mcp-Session-Id no longer exists. The MCP spec says a server MUST answer such
  // a request with 404, which is the signal that tells the client to drop the
  // dead session and re-initialize — the basis for Claude Code auto-reconnecting
  // after the dev server bounces. (A 400 leaves the client re-sending the stale
  // id, so reconnection never converges.)
  it("answers an unknown session id with 404 so the client re-initializes", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "wiped-by-a-restart",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
  });
});
