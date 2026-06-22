import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, selectTools } from "../../src/mcp/server.js";
import { AmaSession } from "../../src/mcp/session.js";

/**
 * Minimal-tools mode (AMA_MCP_TOOLS): an agent can trade Ama's full 27-tool surface for a
 * small high-signal set to cut tool-list noise + token cost. Opt-in — unset means all. (ama-tqm)
 */
describe("minimal-tools mode (ama-tqm)", () => {
  describe("selectTools", () => {
    it("returns null (all tools) when unset or empty", () => {
      expect(selectTools(undefined)).toBeNull();
      expect(selectTools("  ")).toBeNull();
    });

    it("'minimal' is the bootstrap essentials + explore", () => {
      expect([...(selectTools("minimal") ?? [])].sort()).toEqual([
        "explore",
        "index_repository",
        "index_status",
      ]);
    });

    it("a comma list exposes those tools plus the always-usable essentials", () => {
      const set = selectTools("find_callers, find_callees");
      expect(set?.has("find_callers")).toBe(true);
      expect(set?.has("find_callees")).toBe(true);
      expect(set?.has("index_repository")).toBe(true);
    });
  });

  describe("createServer honors the selection over the protocol", () => {
    async function listNames(toolsSpec?: string): Promise<string[]> {
      const server = createServer(new AmaSession(), toolsSpec);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "0" });
      await Promise.all([server.connect(st), client.connect(ct)]);
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      await client.close();
      return names;
    }

    it("minimal mode lists only the essentials + explore", async () => {
      expect(await listNames("minimal")).toEqual(["explore", "index_repository", "index_status"]);
    });

    it("the default (unset) lists the full surface", async () => {
      const all = await listNames(undefined);
      expect(all.length).toBeGreaterThan(20);
      expect(all).toContain("find_callers");
    });
  });
});
