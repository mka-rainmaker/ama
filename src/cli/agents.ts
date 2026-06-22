import * as path from "node:path";

/** A coding agent Ama can wire itself into by merging an entry into the agent's JSON
 *  MCP config. Global (user-scope) configs under $HOME. (ama-di3) */
export interface AgentSpec {
  readonly id: string;
  readonly name: string;
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
    configPath: (h) => path.join(h, ".claude.json"),
    markers: (h) => [path.join(h, ".claude.json"), path.join(h, ".claude")],
  },
  {
    id: "cursor",
    name: "Cursor",
    configPath: (h) => path.join(h, ".cursor", "mcp.json"),
    markers: (h) => [path.join(h, ".cursor")],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    configPath: (h) => path.join(h, ".codeium", "windsurf", "mcp_config.json"),
    markers: (h) => [path.join(h, ".codeium")],
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

/** The agents detected as installed for `home` — any of an agent's markers present. */
export function detectAgents(home: string, exists: (p: string) => boolean): AgentSpec[] {
  return AGENTS.filter((a) => a.markers(home).some(exists));
}
