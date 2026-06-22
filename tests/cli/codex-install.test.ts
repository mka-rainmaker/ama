import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withAmaServerToml, withoutAmaServerToml } from "../../src/cli/agents.js";
import { installAgents, uninstallAgents } from "../../src/cli/commands/install.js";

/**
 * Codex stores MCP servers in TOML (`[mcp_servers.NAME]`), not JSON, so `ama install` needs a
 * TOML-aware merge: append/remove the `[mcp_servers.ama]` table without touching others. (ama-p6h)
 */
describe("Codex TOML config support (ama-p6h)", () => {
  describe("withAmaServerToml / withoutAmaServerToml (pure)", () => {
    it("appends [mcp_servers.ama] preserving other tables", () => {
      const out = withAmaServerToml('[mcp_servers.other]\ncommand = "x"\n');
      expect(out).toContain("[mcp_servers.other]");
      expect(out).toMatch(/\[mcp_servers\.ama\]\ncommand = "ama"\nargs = \["mcp"\]/);
    });

    it("is idempotent", () => {
      const once = withAmaServerToml("");
      const twice = withAmaServerToml(once);
      expect((twice.match(/\[mcp_servers\.ama\]/g) ?? []).length).toBe(1);
      expect(twice.trim()).toBe(once.trim());
    });

    it("removes only the ama section", () => {
      const removed = withoutAmaServerToml(
        withAmaServerToml('[mcp_servers.other]\ncommand = "x"\n'),
      );
      expect(removed).toContain("[mcp_servers.other]");
      expect(removed).not.toContain("[mcp_servers.ama]");
    });
  });

  describe("install/uninstall against a temp Codex config", () => {
    let home: string;
    const cfg = () => path.join(home, ".codex", "config.toml");
    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "ama-codex-"));
      fs.mkdirSync(path.join(home, ".codex"));
      fs.writeFileSync(cfg(), '[mcp_servers.other]\ncommand = "x"\n');
    });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    it("wires ama into Codex's TOML config, preserving other servers", () => {
      expect(installAgents(home).map((r) => r.agent.id)).toContain("codex");
      const toml = fs.readFileSync(cfg(), "utf8");
      expect(toml).toContain("[mcp_servers.ama]");
      expect(toml).toContain('command = "ama"');
      expect(toml).toContain("[mcp_servers.other]");
    });

    it("uninstall removes the ama table from TOML", () => {
      installAgents(home);
      uninstallAgents(home);
      const toml = fs.readFileSync(cfg(), "utf8");
      expect(toml).not.toContain("[mcp_servers.ama]");
      expect(toml).toContain("[mcp_servers.other]");
    });
  });
});
