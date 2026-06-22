import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGENTS,
  type AgentSpec,
  SERVER_NAME,
  detectAgents,
  withAmaServer,
  withAmaServerToml,
  withoutAmaServer,
  withoutAmaServerToml,
} from "../agents.js";
import type { CliCommand } from "../index.js";

interface AgentResult {
  agent: AgentSpec;
  file: string;
  ok: boolean;
  error?: string;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined; // missing or unparseable → start fresh (install) / nothing to remove
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/**
 * Wire ama into every detected agent's MCP config, merging idempotently (other servers and
 * keys preserved). `dryRun` detects but writes nothing. `home` is a parameter so tests run
 * against a temp dir, never the real `~`. (ama-di3)
 */
export function installAgents(home: string, dryRun = false): AgentResult[] {
  return detectAgents(home, fs.existsSync).map((agent) => {
    const file = agent.configPath(home);
    if (dryRun) return { agent, file, ok: true };
    try {
      if (agent.format === "toml") writeText(file, withAmaServerToml(readText(file) ?? ""));
      else writeJson(file, withAmaServer(readJson(file)));
      return { agent, file, ok: true };
    } catch (err) {
      return { agent, file, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Remove ama from every agent config that currently has it. (ama-di3) */
export function uninstallAgents(home: string): AgentResult[] {
  const out: AgentResult[] = [];
  for (const agent of AGENTS) {
    const file = agent.configPath(home);
    try {
      if (agent.format === "toml") {
        const text = readText(file);
        if (!text?.includes(`[mcp_servers.${SERVER_NAME}]`)) continue;
        writeText(file, withoutAmaServerToml(text));
      } else {
        const config = readJson(file);
        const servers = config?.mcpServers as Record<string, unknown> | undefined;
        if (!config || !servers || !(SERVER_NAME in servers)) continue;
        writeJson(file, withoutAmaServer(config));
      }
      out.push({ agent, file, ok: true });
    } catch (err) {
      out.push({ agent, file, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export const installCommand: CliCommand = {
  name: "install",
  summary: "Wire the ama MCP server into your installed coding agents (--dry-run to preview)",
  run(args, ctx) {
    const dryRun = args.includes("--dry-run");
    const results = installAgents(os.homedir(), dryRun);
    if (results.length === 0) {
      ctx.error?.(
        "No supported agents detected (Claude Code, Cursor, Windsurf, Codex). See the README to configure manually.",
      );
      return 1;
    }
    for (const r of results) {
      if (!r.ok) ctx.error?.(`✗ ${r.agent.name}: ${r.error}`);
      else ctx.write(`${dryRun ? "would wire" : "✓"} ${r.agent.name.padEnd(12)} ${r.file}`);
    }
    if (!dryRun && results.some((r) => r.ok)) ctx.write("Restart the agent(s) to load Ama.");
    return results.some((r) => !r.ok) ? 1 : 0;
  },
};

export const uninstallCommand: CliCommand = {
  name: "uninstall",
  summary: "Remove the ama MCP server from your coding agents",
  run(_args, ctx) {
    const results = uninstallAgents(os.homedir());
    if (results.length === 0) {
      ctx.write("Ama was not wired into any detected agent.");
      return 0;
    }
    for (const r of results) {
      if (!r.ok) ctx.error?.(`✗ ${r.agent.name}: ${r.error}`);
      else ctx.write(`✓ removed from ${r.agent.name}`);
    }
    return results.some((r) => !r.ok) ? 1 : 0;
  },
};
