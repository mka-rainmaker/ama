import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTS, detectAgents, withAmaServer, withoutAmaServer } from "../../src/cli/agents.js";

/**
 * `ama install` wires the MCP server into coding agents by merging a `mcpServers.ama` entry
 * into each agent's JSON config. The merge must be idempotent and never touch other servers
 * or keys; detection keys off each agent's on-disk marker. (ama-di3)
 */
describe("agent config merge (ama-di3)", () => {
  it("withAmaServer adds the ama entry, preserving other servers and top-level keys", () => {
    const out = withAmaServer({ numProjects: 3, mcpServers: { other: { command: "x" } } });
    expect(out).toEqual({
      numProjects: 3,
      mcpServers: { other: { command: "x" }, ama: { command: "ama", args: ["mcp"] } },
    });
  });

  it("withAmaServer creates mcpServers when the config is empty or undefined", () => {
    expect(withAmaServer(undefined)).toEqual({
      mcpServers: { ama: { command: "ama", args: ["mcp"] } },
    });
  });

  it("withAmaServer is idempotent", () => {
    const once = withAmaServer(undefined);
    expect(withAmaServer(once)).toEqual(once);
  });

  it("withoutAmaServer removes only the ama entry", () => {
    const out = withoutAmaServer({
      mcpServers: { ama: { command: "ama" }, other: { command: "x" } },
    });
    expect(out.mcpServers).toEqual({ other: { command: "x" } });
  });

  it("detectAgents returns the agents whose marker exists on disk", () => {
    const home = "/home/u";
    const exists = (p: string) => p === path.join(home, ".cursor");
    const ids = detectAgents(home, exists).map((a) => a.id);
    expect(ids).toContain("cursor");
    expect(ids).not.toContain("windsurf");
  });

  it("every agent resolves an absolute config path under home", () => {
    for (const a of AGENTS) expect(path.isAbsolute(a.configPath("/home/u"))).toBe(true);
  });
});
