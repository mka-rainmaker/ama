import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installAgents, uninstallAgents } from "../../src/cli/commands/install.js";

/**
 * `ama install` wires the MCP server into detected agents by merging into their JSON config.
 * Driven against a temp HOME (never the real `~`), with a fake `.cursor/` marking Cursor as
 * installed. (ama-di3)
 */
describe("ama install / uninstall (ama-di3)", () => {
  let home: string;
  const cursorCfg = () => path.join(home, ".cursor", "mcp.json");
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ama-install-"));
    fs.mkdirSync(path.join(home, ".cursor")); // Cursor "installed"; Windsurf/Claude are not
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("wires ama into a detected agent, creating the config file", () => {
    const results = installAgents(home);
    expect(results.map((r) => r.agent.id)).toEqual(["cursor"]);
    const cfg = JSON.parse(fs.readFileSync(cursorCfg(), "utf8"));
    expect(cfg.mcpServers.ama).toEqual({ command: "ama", args: ["mcp"] });
  });

  it("merges without clobbering an existing server", () => {
    fs.writeFileSync(cursorCfg(), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    installAgents(home);
    const cfg = JSON.parse(fs.readFileSync(cursorCfg(), "utf8"));
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
    expect(cfg.mcpServers.ama).toBeDefined();
  });

  it("--dry-run detects but writes nothing", () => {
    const results = installAgents(home, true);
    expect(results.map((r) => r.agent.id)).toEqual(["cursor"]);
    expect(fs.existsSync(cursorCfg())).toBe(false);
  });

  it("skips agents that aren't installed", () => {
    expect(installAgents(home).map((r) => r.agent.id)).not.toContain("windsurf");
  });

  it("uninstall removes only the ama entry", () => {
    fs.writeFileSync(
      cursorCfg(),
      JSON.stringify({ mcpServers: { ama: { command: "ama" }, other: { command: "x" } } }),
    );
    uninstallAgents(home);
    const cfg = JSON.parse(fs.readFileSync(cursorCfg(), "utf8"));
    expect(cfg.mcpServers.ama).toBeUndefined();
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
  });
});
