import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const tsx = path.resolve(repoRoot, "node_modules/.bin/tsx");

/**
 * `ama mcp` is the entry coding agents spawn: it must start the code-intelligence MCP
 * server over stdio and speak the protocol. Proven end-to-end by driving the real CLI
 * subprocess with the MCP SDK's stdio client. (ama-fmu)
 */
describe("ama mcp — stdio MCP server entry (ama-fmu)", () => {
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close().catch(() => {});
    client = undefined;
  });

  it("starts the server over stdio and advertises its tools", async () => {
    const transport = new StdioClientTransport({
      command: tsx,
      args: ["src/cli/index.ts", "mcp"],
      cwd: repoRoot,
      // Skip the WASM-tier re-exec for a deterministic single-process spawn; the pin only
      // matters for large indexes, not this handshake.
      env: { ...process.env, AMA_WASM_TIER_REEXEC: "1" },
    });
    client = new Client({ name: "ama-mcp-test", version: "0.0.0" });
    await client.connect(transport);

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("index_repository");
    expect(names).toContain("search_symbol");
  }, 20000);
});
