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
 * Wrap a read handler so it first runs a connect-time catch-up (reconciling any
 * edits made while disconnected) and then replies with a staleness banner if
 * the auto-syncer is mid-window. Keeps that policy in one place across the
 * query tools.
 */
function queryTool<A>(session: AmaSession, run: (args: A) => unknown) {
  return async (args: A) => {
    await session.catchUpIfNeeded();
    return reply(session, run(args));
  };
}

/** Compact `key=value` rendering of a tool's arguments for a log line. */
function argsHint(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const pairs = Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  return pairs.length ? ` ${pairs.join(", ")}` : "";
}

/** A one-glance summary of a tool result — list length, index counts, etc. */
function resultHint(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> } | undefined)?.content;
  if (!content?.length) return "ok";
  const stale = content.length > 1 ? "stale, " : "";
  const text = content[content.length - 1]?.text ?? "";
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return `${stale}${text.slice(0, 60)}`;
  }
  if (Array.isArray(data)) {
    return `${stale}${data.length} result${data.length === 1 ? "" : "s"}`;
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if ("nodeCount" in o) return `${stale}${o.nodeCount} nodes, ${o.edgeCount} edges`;
    if ("changed" in o) {
      const changed = (o.changed as unknown[] | undefined)?.length ?? 0;
      const removed = (o.removed as unknown[] | undefined)?.length ?? 0;
      return `${stale}${changed} changed, ${removed} removed`;
    }
    if ("startLine" in o) return `${stale}${o.file}:${o.startLine}-${o.endLine}`;
    return `${stale}ok`;
  }
  return `${stale}none`;
}

/**
 * Wrap a tool handler so each invocation prints one stderr line when
 * AMA_LOG_TOOLS is set — the tool name, its arguments, and a short summary of
 * the reply — purely so the dev loop can see a tool was really called. Logging
 * goes to stderr only, leaving the stdout JSON-RPC stream untouched; the
 * `serve:dev` script turns it on. Reads the env per call so it can be toggled
 * without rebuilding the wrapper.
 */
function tap<A, R>(name: string, run: (args: A) => R | Promise<R>): (args: A) => Promise<R> {
  return async (args: A) => {
    const result = await run(args);
    if (process.env.AMA_LOG_TOOLS) {
      console.error(`[ama] ${name}${argsHint(args)} → ${resultHint(result)}`);
    }
    return result;
  };
}

/**
 * Build the MCP server exposing Ama's tools over one {@link AmaSession}. Pure
 * construction — no transport — so it can be driven by an in-memory client in
 * tests or by stdio in production.
 */
export function createServer(session: AmaSession = new AmaSession()): McpServer {
  const server = new McpServer({ name: "ama", version: "0.0.1" });

  // Fires on each connection's initialize handshake — i.e. on reconnect. Arm a
  // catch-up so the first query reconciles edits made while disconnected.
  server.server.oninitialized = () => session.markForCatchUp();

  server.registerTool(
    "index_repository",
    {
      description: "Build the code graph for a directory or project. Run this first.",
      inputSchema: {
        path: z.string().describe("Directory to index (absolute or relative)."),
      },
    },
    tap("index_repository", async ({ path }: { path: string }) =>
      json(await session.indexRepository(path)),
    ),
  );

  server.registerTool(
    "index_status",
    {
      description:
        "Whether anything is indexed, with node/edge counts, per-language coverage + tier, " +
        "and how many edits are pending auto-sync.",
      inputSchema: {},
    },
    tap("index_status", async () => {
      await session.catchUpIfNeeded();
      return json(session.indexStatus());
    }),
  );

  server.registerTool(
    "sync_index",
    {
      description:
        "Reconcile files that changed on disk since indexing (a manual catch-up). " +
        "Returns the repo-relative paths re-indexed and removed.",
      inputSchema: {},
    },
    tap("sync_index", async () => json(await session.sync())),
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
    tap(
      "search_symbol",
      queryTool(session, ({ query, limit }: { query: string; limit?: number }) =>
        session.searchSymbol(query, { limit }),
      ),
    ),
  );

  server.registerTool(
    "find_callers",
    {
      description: "Every place that calls a function or method.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "find_callers",
      queryTool(session, ({ symbol }: { symbol: string }) => session.findCallers(symbol)),
    ),
  );

  server.registerTool(
    "find_callees",
    {
      description: "What a function or method calls.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "find_callees",
      queryTool(session, ({ symbol }: { symbol: string }) => session.findCallees(symbol)),
    ),
  );

  server.registerTool(
    "find_implementations",
    {
      description: "Every class that implements an interface.",
      inputSchema: {
        symbol: z.string().describe("Interface id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "find_implementations",
      queryTool(session, ({ symbol }: { symbol: string }) => session.findImplementations(symbol)),
    ),
  );

  server.registerTool(
    "find_interfaces",
    {
      description: "The interfaces a class implements.",
      inputSchema: {
        symbol: z.string().describe("Class id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "find_interfaces",
      queryTool(session, ({ symbol }: { symbol: string }) => session.findInterfaces(symbol)),
    ),
  );

  server.registerTool(
    "find_importers",
    {
      description: "Every file that imports (or re-exports) a symbol.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "find_importers",
      queryTool(session, ({ symbol }: { symbol: string }) => session.findImporters(symbol)),
    ),
  );

  server.registerTool(
    "find_imports",
    {
      description: "The symbols a file imports (or re-exports).",
      inputSchema: {
        file: z.string().describe("File node id (repo-relative path) or basename."),
      },
    },
    tap(
      "find_imports",
      queryTool(session, ({ file }: { file: string }) => session.findImports(file)),
    ),
  );

  server.registerTool(
    "find_type_users",
    {
      description: "Every symbol that uses a type in a parameter, return, or property.",
      inputSchema: {
        type: z.string().describe("Type id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "find_type_users",
      queryTool(session, ({ type }: { type: string }) => session.findTypeUsers(type)),
    ),
  );

  server.registerTool(
    "find_types_used",
    {
      description: "The named types a symbol uses in its parameters, return, or properties.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "find_types_used",
      queryTool(session, ({ symbol }: { symbol: string }) => session.findTypesUsed(symbol)),
    ),
  );

  server.registerTool(
    "get_code_snippet",
    {
      description: "A symbol's verbatim source.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "get_code_snippet",
      queryTool(session, ({ symbol }: { symbol: string }) => session.getCodeSnippet(symbol)),
    ),
  );

  server.registerTool(
    "node",
    {
      description:
        "Everything about one symbol or file at once: definition, source, callers, callees, " +
        "and dependents.",
      inputSchema: {
        ref: z.string().describe("Symbol or file id, simple name, or dotted/path reference."),
      },
    },
    tap(
      "node",
      queryTool(session, ({ ref }: { ref: string }) => session.node(ref)),
    ),
  );

  server.registerTool(
    "impact_analysis",
    {
      description:
        "The transitive blast radius of a symbol: everything that could break if you change it " +
        "(callers, callers of callers, …), optionally bounded by depth.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
        maxDepth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max levels of callers to traverse (default: unbounded)."),
      },
    },
    tap(
      "impact_analysis",
      queryTool(session, ({ symbol, maxDepth }: { symbol: string; maxDepth?: number }) =>
        session.impactAnalysis(symbol, maxDepth),
      ),
    ),
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
