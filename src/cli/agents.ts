import * as path from "node:path";

/** A coding agent Ama can wire itself into by merging an entry into the agent's MCP config —
 *  JSON (`mcpServers`) for most, TOML (`[mcp_servers.ama]`) for Codex. Global (user-scope)
 *  configs under $HOME. (ama-di3, ama-p6h) */
export interface AgentSpec {
  readonly id: string;
  readonly name: string;
  /** Config file format — JSON for most agents, TOML for Codex. */
  readonly format: "json" | "toml";
  /** The MCP config file to merge the ama server into. */
  configPath(home: string): string;
  /** Paths whose existence means this agent is installed; detection succeeds if any exists. */
  markers(home: string): string[];
}

/** The key Ama registers itself under in an agent's `mcpServers`. */
export const SERVER_NAME = "ama";
/** The MCP server entry written for each agent. `ama` is on PATH (the user ran `ama install`). */
export const AMA_SERVER = { command: "ama", args: ["mcp"] } as const;

export const AGENTS: readonly AgentSpec[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    format: "json",
    configPath: (h) => path.join(h, ".claude.json"),
    markers: (h) => [path.join(h, ".claude.json"), path.join(h, ".claude")],
  },
  {
    id: "cursor",
    name: "Cursor",
    format: "json",
    configPath: (h) => path.join(h, ".cursor", "mcp.json"),
    markers: (h) => [path.join(h, ".cursor")],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    format: "json",
    configPath: (h) => path.join(h, ".codeium", "windsurf", "mcp_config.json"),
    markers: (h) => [path.join(h, ".codeium")],
  },
  {
    id: "codex",
    name: "Codex",
    format: "toml",
    configPath: (h) => path.join(h, ".codex", "config.toml"),
    markers: (h) => [path.join(h, ".codex")],
  },
];

type Json = Record<string, unknown>;

/** Add the ama MCP server to a config, preserving every other key and server. Pure +
 *  idempotent — re-running yields the same config. (ama-di3) */
export function withAmaServer(config: Json | undefined): Json {
  const next: Json = { ...(config ?? {}) };
  const servers: Json = { ...((next.mcpServers as Json | undefined) ?? {}) };
  servers[SERVER_NAME] = { ...AMA_SERVER };
  next.mcpServers = servers;
  return next;
}

/** Remove the ama MCP server, leaving every other server and key intact. Pure. (ama-di3) */
export function withoutAmaServer(config: Json | undefined): Json {
  const next: Json = { ...(config ?? {}) };
  const servers: Json = { ...((next.mcpServers as Json | undefined) ?? {}) };
  delete servers[SERVER_NAME];
  next.mcpServers = servers;
  return next;
}

/** The canonical Codex TOML table for the ama server (rendered from {@link AMA_SERVER}). */
const AMA_TOML_SECTION = `[mcp_servers.${SERVER_NAME}]\ncommand = "${AMA_SERVER.command}"\nargs = [${AMA_SERVER.args
  .map((a) => `"${a}"`)
  .join(", ")}]\n`;
const AMA_TOML_HEADER = `[mcp_servers.${SERVER_NAME}]`;

/** Remove the `[mcp_servers.ama]` table (its header through the line before the next table
 *  header, or EOF) from a TOML string. */
function removeAmaToml(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === AMA_TOML_HEADER);
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end++;
  lines.splice(start, end - start);
  return lines.join("\n");
}

/** Add the ama MCP server to a Codex-style TOML config (text form — no TOML parser needed),
 *  preserving other tables. Idempotent: strip any existing ama table, then append a fresh one.
 *  (ama-p6h) */
export function withAmaServerToml(text: string): string {
  const base = removeAmaToml(text).replace(/\n+$/, "");
  return base ? `${base}\n\n${AMA_TOML_SECTION}` : AMA_TOML_SECTION;
}

/** Remove the ama MCP server table from a TOML config (text). (ama-p6h) */
export function withoutAmaServerToml(text: string): string {
  return removeAmaToml(text).replace(/\n{3,}/g, "\n\n");
}

/** The agents detected as installed for `home` — any of an agent's markers present. */
export function detectAgents(home: string, exists: (p: string) => boolean): AgentSpec[] {
  return AGENTS.filter((a) => a.markers(home).some(exists));
}
