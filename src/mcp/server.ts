import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AmaSession } from "./session.js";

/** JSON tool result helper. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * A query result, with a staleness warning prepended when the auto-syncer has
 * edits still in its debounce window — so a caller sees the caveat before the
 * (possibly stale) data. No banner ⇒ identical to {@link json}.
 */
function reply(session: AmaSession, value: unknown) {
  const banner = session.stalenessBanner();
  const data = { type: "text" as const, text: JSON.stringify(value, null, 2) };
  return { content: banner ? [{ type: "text" as const, text: banner }, data] : [data] };
}

/**
 * Build the MCP server exposing Ama's tools over one {@link AmaSession}. Pure
 * construction — no transport — so it can be driven by an in-memory client in
 * tests or by stdio in production.
 */
export function createServer(session: AmaSession = new AmaSession()): McpServer {
  const server = new McpServer({ name: "ama", version: "0.0.1" });

  server.registerTool(
    "index_repository",
    {
      description: "Build the code graph for a directory or project. Run this first.",
      inputSchema: {
        path: z.string().describe("Directory to index (absolute or relative)."),
      },
    },
    async ({ path }) => json(await session.indexRepository(path)),
  );

  server.registerTool(
    "index_status",
    {
      description:
        "Whether anything is indexed, with node/edge counts, per-language coverage + tier, " +
        "and how many edits are pending auto-sync.",
      inputSchema: {},
    },
    async () => json(session.indexStatus()),
  );

  server.registerTool(
    "sync_index",
    {
      description:
        "Reconcile files that changed on disk since indexing (a manual catch-up). " +
        "Returns the repo-relative paths re-indexed and removed.",
      inputSchema: {},
    },
    async () => json(await session.sync()),
  );

  server.registerTool(
    "search_symbol",
    {
      description: "Find symbols by name (case-insensitive substring).",
      inputSchema: {
        query: z.string().describe("Name or partial name to search for."),
        limit: z.number().int().positive().optional().describe("Max results."),
      },
    },
    async ({ query, limit }) => reply(session, session.searchSymbol(query, { limit })),
  );

  server.registerTool(
    "find_callers",
    {
      description: "Every place that calls a function or method.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
      },
    },
    async ({ symbol }) => reply(session, session.findCallers(symbol)),
  );

  server.registerTool(
    "find_callees",
    {
      description: "What a function or method calls.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
      },
    },
    async ({ symbol }) => reply(session, session.findCallees(symbol)),
  );

  server.registerTool(
    "find_implementations",
    {
      description: "Every class that implements an interface.",
      inputSchema: {
        symbol: z.string().describe("Interface id, simple name, or dotted qualified name."),
      },
    },
    async ({ symbol }) => reply(session, session.findImplementations(symbol)),
  );

  server.registerTool(
    "find_interfaces",
    {
      description: "The interfaces a class implements.",
      inputSchema: {
        symbol: z.string().describe("Class id, simple name, or dotted qualified name."),
      },
    },
    async ({ symbol }) => reply(session, session.findInterfaces(symbol)),
  );

  server.registerTool(
    "find_importers",
    {
      description: "Every file that imports (or re-exports) a symbol.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
      },
    },
    async ({ symbol }) => reply(session, session.findImporters(symbol)),
  );

  server.registerTool(
    "find_imports",
    {
      description: "The symbols a file imports (or re-exports).",
      inputSchema: {
        file: z.string().describe("File node id (repo-relative path) or basename."),
      },
    },
    async ({ file }) => reply(session, session.findImports(file)),
  );

  server.registerTool(
    "get_code_snippet",
    {
      description: "A symbol's verbatim source.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
      },
    },
    async ({ symbol }) => reply(session, session.getCodeSnippet(symbol)),
  );

  return server;
}

/** Entry point: serve over stdio. stdout carries JSON-RPC only — log to stderr. */
export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error("ama MCP server running on stdio");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
