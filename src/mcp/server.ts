import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NODE_KINDS } from "../graph/index.js";
import type { NodeKind } from "../graph/index.js";
import { DEFAULT_SEARCH_LIMIT } from "../query/service.js";
import { ensureBaselineWasmTier } from "../runtime/wasm-tier.js";
import { AmaSession } from "./session.js";

/** JSON tool result helper. `value ?? null` so an `undefined` result (e.g. a
 * snippet/node for an unresolved symbol) serializes to `"null"` rather than the
 * JS value `undefined`, which would make the MCP content invalid. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value ?? null, null, 2) }] };
}

/**
 * A query result, with a staleness warning prepended when the auto-syncer has
 * edits still in its debounce window — so a caller sees the caveat before the
 * (possibly stale) data. No banner ⇒ identical to {@link json}.
 */
function reply(session: AmaSession, value: unknown, hint?: string) {
  const banner = session.stalenessBanner();
  const text = (t: string) => ({ type: "text" as const, text: t });
  const content = [text(JSON.stringify(value ?? null, null, 2))];
  // Banner first (most urgent: results may be stale); hint last (advisory). The
  // data block stays at a fixed position so a consumer reading the JSON is robust.
  if (banner) content.unshift(text(banner));
  if (hint) content.push(text(hint));
  return { content };
}

/** Slice search results to `limit` and, when the search returned more than that
 *  (the handler requests `limit + 1`), append an advisory so a capped list isn't
 *  mistaken for the whole answer — search_symbol/search_code otherwise truncate
 *  silently. Composes with an existing hint (e.g. low-confidence). (ama-b4q) */
export function capped<T>(
  results: T[],
  limit: number,
  baseHint?: string,
): { shown: T[]; hint?: string } {
  const truncated = results.length > limit;
  const shown = truncated ? results.slice(0, limit) : results;
  const truncHint = truncated
    ? `⚠️ Ama: showing the first ${limit} matches — more exist. Refine with a more specific query or path:/kind:/lang:/name: filters, or raise \`limit\`.`
    : undefined;
  const hint = [baseHint, truncHint].filter(Boolean).join("\n") || undefined;
  return { shown, hint };
}

/** Optional `projectPath` for the cross-project query tools: target another indexed
 *  project by its root (or a path inside it); omit for the primary. (ama-ont) */
const projectPathSchema = z
  .string()
  .optional()
  .describe(
    "Query another indexed project by its root path (or a path inside it); omit for the " +
      "primary (last-indexed) project. index_status lists the indexed projects.",
  );

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

/** A one-glance summary of a tool result — list length, index counts, etc.
 *  Exported for unit testing of its banner/hint handling. */
export function resultHint(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> } | undefined)?.content;
  if (!content?.length) return "ok";
  // reply() prepends a staleness banner and/or appends an advisory hint around
  // the JSON data block. Locate the data by which block parses as JSON, and read
  // staleness from a banner *before* it (dataIdx > 0) — not the block count,
  // which a trailing low-confidence hint also inflates. (ama-zk6)
  let data: unknown;
  let dataIdx = -1;
  for (let i = 0; i < content.length; i++) {
    try {
      data = JSON.parse(content[i]?.text ?? "");
      dataIdx = i;
      break;
    } catch {}
  }
  const stale = dataIdx > 0 ? "stale, " : "";
  if (dataIdx === -1) {
    return content[0]?.text?.slice(0, 60) || "none";
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
      description:
        "Find symbols by name (case-insensitive substring). The query also accepts " +
        "inline filters to scope a search: path:<file-substring>, kind:<NodeKind>, " +
        "lang:<typescript|python|…>, name:<substring> (quote values with spaces). " +
        "E.g. `handler path:src/api kind:Function` or, filters-only, `path:src/store kind:Class`.",
      inputSchema: {
        query: z
          .string()
          .describe("Name or partial name, optionally with path:/kind:/lang:/name: filters."),
        limit: z.number().int().positive().optional().describe("Max results."),
        kind: z.enum(NODE_KINDS).optional().describe("Restrict to a single node kind."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "search_symbol",
      async ({
        query,
        limit,
        kind,
        projectPath,
      }: { query: string; limit?: number; kind?: NodeKind; projectPath?: string }) => {
        await session.catchUpIfNeeded();
        const max = limit ?? DEFAULT_SEARCH_LIMIT;
        const { results, lowConfidence } = session.searchSymbolWithConfidence(
          query,
          { limit: max + 1, kind },
          projectPath,
        );
        const lowHint = lowConfidence
          ? `⚠️ Ama: no exact or name-prefix match for "${query}" — these are loose substring hits, so they may not be what you meant. Double-check the name or refine the query.`
          : undefined;
        const { shown, hint } = capped(results, max, lowHint);
        return reply(session, shown, hint);
      },
    ),
  );

  server.registerTool(
    "find_callers",
    {
      description:
        "Every place that calls a function or method — each result is " +
        "{ symbol, at: { line, column } } so you see who calls it and where.",
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
      description:
        "What a function or method calls — each result is { symbol, at: { line, column } }, " +
        "the callee and the call site.",
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
    "find_handlers",
    {
      description: "The handler symbols a framework route maps to.",
      inputSchema: {
        route: z.string().describe('Route id or name, e.g. "GET /users".'),
      },
    },
    tap(
      "find_handlers",
      queryTool(session, ({ route }: { route: string }) => session.findHandlers(route)),
    ),
  );

  server.registerTool(
    "find_routes",
    {
      description: "Every framework route that maps to a symbol (handler).",
      inputSchema: {
        symbol: z.string().describe("Handler symbol id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "find_routes",
      queryTool(session, ({ symbol }: { symbol: string }) => session.findRoutes(symbol)),
    ),
  );

  server.registerTool(
    "find_overrides",
    {
      description:
        "The supertype methods a method overrides or implements (method → the " +
        "interface/base method of the same name).",
      inputSchema: {
        symbol: z.string().describe("Method id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "find_overrides",
      queryTool(session, ({ symbol }: { symbol: string }) => session.findOverrides(symbol)),
    ),
  );

  server.registerTool(
    "find_overridden_by",
    {
      description:
        "The subtype methods that override a method — what breaks if you change this " +
        "interface/base method.",
      inputSchema: {
        symbol: z.string().describe("Method id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "find_overridden_by",
      queryTool(session, ({ symbol }: { symbol: string }) => session.findOverriddenBy(symbol)),
    ),
  );

  server.registerTool(
    "find_referrers",
    {
      description:
        "Everything that references a symbol via a References edge: who reads a module-level " +
        "constant/variable, the routes that map to a handler, and other dispatch references. " +
        "Use this for 'who uses X' when X isn't called (reads aren't calls, so find_callers " +
        "won't see them).",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "find_referrers",
      queryTool(session, ({ symbol }: { symbol: string }) => session.findReferrers(symbol)),
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
    "find_returns",
    {
      description:
        "The named type(s) a function or method returns — the return half of find_types_used.",
      inputSchema: {
        symbol: z.string().describe("Function/method id, simple name, or dotted qualified name."),
      },
    },
    tap(
      "find_returns",
      queryTool(session, ({ symbol }: { symbol: string }) => session.findReturns(symbol)),
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
        projectPath: projectPathSchema,
      },
    },
    tap(
      "node",
      queryTool(session, ({ ref, projectPath }: { ref: string; projectPath?: string }) =>
        session.node(ref, projectPath),
      ),
    ),
  );

  server.registerTool(
    "file_skeleton",
    {
      description:
        "A file's outline in one call: the symbols it defines (kind, name, line range) " +
        "plus the files that depend on it — a structured, cheaper alternative to reading " +
        "the whole file.",
      inputSchema: {
        file: z.string().describe("File node id (repo-relative path) or basename."),
      },
    },
    tap(
      "file_skeleton",
      queryTool(session, ({ file }: { file: string }) => session.fileSkeleton(file)),
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

  server.registerTool(
    "get_graph_schema",
    {
      description:
        "A census of the index: how many nodes of each kind and edges of each kind it holds.",
      inputSchema: {},
    },
    tap(
      "get_graph_schema",
      queryTool(session, () => session.getGraphSchema()),
    ),
  );

  server.registerTool(
    "circular_imports",
    {
      description:
        "File-level import cycles: groups of two or more files that (transitively) import " +
        "each other. Each group is a strongly-connected component — high-signal for refactoring " +
        "and untangling module graphs. Empty when the import graph is acyclic.",
      inputSchema: {},
    },
    tap(
      "circular_imports",
      queryTool(session, () => session.circularImports()),
    ),
  );

  server.registerTool(
    "affected",
    {
      description:
        "Files affected by changing the given files: the transitive set that imports from them " +
        "(directly or via a defined symbol) — which files/tests to recheck. Pass testsOnly to " +
        "get just the affected test files (which tests to run for a change).",
      inputSchema: {
        files: z.array(z.string()).describe("File node ids (repo-relative paths) or basenames."),
        testsOnly: z
          .boolean()
          .optional()
          .describe("Return only the affected test files (test-impact mode)."),
      },
    },
    tap(
      "affected",
      queryTool(session, ({ files, testsOnly }: { files: string[]; testsOnly?: boolean }) =>
        session.affected(files, { testsOnly }),
      ),
    ),
  );

  server.registerTool(
    "search_code",
    {
      description:
        "Full-text search over symbol bodies — find code containing a string, not just by name.",
      inputSchema: {
        query: z.string().describe("Text to find inside symbol source (case-insensitive)."),
        limit: z.number().int().positive().optional().describe("Max results."),
      },
    },
    tap("search_code", async ({ query, limit }: { query: string; limit?: number }) => {
      await session.catchUpIfNeeded();
      const max = limit ?? DEFAULT_SEARCH_LIMIT;
      const { results, viaTerms } = session.searchCodeWithConfidence(query, { limit: max + 1 });
      const termHint = viaTerms
        ? `⚠️ Ama: no symbol body contains the exact phrase "${query}" — these match its words separately and may be unrelated. Search a shorter exact phrase to narrow.`
        : undefined;
      const { shown, hint } = capped(results, max, termHint);
      return reply(session, shown, hint);
    }),
  );

  server.registerTool(
    "explore",
    {
      description:
        "A one-call overview of a question: matching symbols grouped by file, their " +
        "caller/callee relationships, and the combined blast radius. Deep-dives only the " +
        "top matches (see totalMatches); pass limit to widen or narrow.",
      inputSchema: {
        question: z.string().describe("A name or term to explore around."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How many top matches to deep-dive (default 15)."),
      },
    },
    tap(
      "explore",
      queryTool(session, ({ question, limit }: { question: string; limit?: number }) =>
        session.explore(question, { limit }),
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
  // Pin grammar WASM to the baseline compiler before anything loads it, or a
  // long-running index OOMs (ama-rgx). Re-execs once; the supervisor skips main.
  if (!ensureBaselineWasmTier()) {
    main().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
}
