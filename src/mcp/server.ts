import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NODE_KINDS } from "../graph/index.js";
import type { NodeKind } from "../graph/index.js";
import { DEFAULT_SEARCH_LIMIT } from "../query/service.js";
import { isEntrypoint } from "../runtime/entrypoint.js";
import { ensureBaselineWasmTier } from "../runtime/wasm-tier.js";
import { serverStamp } from "./build-info.js";
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
function reply(session: AmaSession, value: unknown, hint?: string, signal?: unknown) {
  const banner = session.stalenessBanner();
  const text = (t: string) => ({ type: "text" as const, text: t });
  const content = [text(JSON.stringify(value ?? null, null, 2))];
  // Banner first (most urgent: results may be stale); hint last (advisory). The
  // data block stays at a fixed position so a consumer reading the JSON is robust.
  if (banner) content.unshift(text(banner));
  if (hint) content.push(text(hint));
  // A structured, machine-readable signal (e.g. the tier of an empty relationship result) as its own
  // JSON-object block — so an agent branches on a field, not prose. The data block (an array) is
  // unchanged, so it never collides with this object. (#52)
  if (signal !== undefined) content.push(text(JSON.stringify(signal, null, 2)));
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
    await session.ensureIndexed();
    await session.catchUpIfNeeded();
    return reply(session, run(args));
  };
}

/**
 * Like {@link queryTool}, but for a relationship query whose result is an array of neighbors
 * (find_callers/callees/implementations, impact_analysis). A result on a BASELINE-tier symbol is
 * never fully authoritative — at the syntactic tier Ama can't resolve every edge, so an *empty*
 * result may mean "not resolved" (not "none") and a *non-empty* one may be incomplete. It attaches a
 * **structured** `{ tier, authoritative: false, note }` signal (a machine-readable field an agent
 * branches on, not prose — #52, upgrading #45's text caveat) whenever the symbol is baseline-tier;
 * the `note` adapts to empty vs non-empty and keeps the human-readable text. A deep-tier symbol gets
 * no signal — its results are authoritative.
 */
function relationTool<A extends { projectPath?: string }>(
  session: AmaSession,
  refOf: (args: A) => string,
  run: (args: A) => unknown[],
) {
  return async (args: A) => {
    await session.ensureIndexed();
    await session.catchUpIfNeeded();
    const result = run(args);
    const ref = refOf(args);
    const signal =
      session.symbolTier(ref, args.projectPath) === "baseline"
        ? {
            tier: "baseline",
            authoritative: false,
            note:
              result.length === 0
                ? `Empty result at baseline (syntactic) tier — Ama may not have resolved this relationship for "${ref}"; this does not mean none exist. Confirm with search_code/grep.`
                : `Baseline (syntactic) tier — this list may be INCOMPLETE for "${ref}" (cross-module or otherwise unresolved edges can be missed). Confirm completeness with search_code/grep.`,
          }
        : undefined;
    return reply(session, result, undefined, signal);
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

/** Tools always exposed (the index bootstrap) even when AMA_MCP_TOOLS filters the rest. */
const ESSENTIAL_TOOLS = ["index_repository", "index_status"];

/**
 * Resolve AMA_MCP_TOOLS into the set of tool names to expose, or null for all (the default,
 * non-breaking). `minimal` → the essentials + `explore`; a comma list → the essentials + those
 * names. Lets an agent trade the full 27-tool surface for a tiny high-signal set. (ama-tqm)
 */
export function selectTools(spec: string | undefined): Set<string> | null {
  const raw = spec?.trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "minimal") return new Set([...ESSENTIAL_TOOLS, "explore"]);
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...ESSENTIAL_TOOLS, ...names]);
}

/**
 * Server-level usage guidance returned in the MCP `initialize` handshake. MCP
 * clients (e.g. Claude Code) inject this into the agent's context on every
 * session — including subagents — so it is Ama's one in-band channel for telling
 * an agent *when* to prefer these tools over grep/file-reads. Without it, an agent
 * that just installed Ama never discovers that a who-calls/impact question is one
 * tool call rather than a grep sweep — the core "agents don't use Ama" feedback.
 * Keep it tight (it costs context on every session) and tier-honest. (closes #19)
 */
const AMA_INSTRUCTIONS = `Ama parses this codebase into a queryable graph of symbols and relationships. Prefer Ama's tools over grep/ripgrep and file reads for any STRUCTURAL question — where a symbol is defined, who calls or imports it, what implements an interface, what breaks if it changes — because one call returns a precise, graph-backed answer instead of many text matches.

First call index_repository on the project root (or index_status to check what is indexed); after that the file watcher keeps the graph current. Then reach for: search_symbol / search_code (locate), get_code_snippet / file_skeleton (read), find_callers / find_callees / find_implementations / find_importers (relationships), impact_analysis / affected / explore (blast radius).

Every result reports its analyzer tier — deep (semantic) or baseline (syntactic). Trust deep-tier relationship results; on baseline tier, treat an empty caller/impact result as "not resolved", not "none", and confirm with a targeted search. Use grep only for plain text/log/config strings the graph does not model.`;

/**
 * Build the MCP server exposing Ama's tools over one {@link AmaSession}. Pure
 * construction — no transport — so it can be driven by an in-memory client in
 * tests or by stdio in production.
 */
export function createServer(
  session: AmaSession = new AmaSession(),
  toolsSpec: string | undefined = process.env.AMA_MCP_TOOLS,
): McpServer {
  const server = new McpServer(
    { name: "ama", version: serverStamp.version },
    { instructions: AMA_INSTRUCTIONS },
  );

  // AMA_MCP_TOOLS minimal-tools mode: register everything, but disable (hide from
  // tools/list) any tool not in the selected set. Bind first so the `tool` rename below
  // never recurses into the wrapper. (ama-tqm)
  const selected = selectTools(toolsSpec);
  const baseRegister = server.registerTool.bind(server);
  // biome-ignore lint/suspicious/noExplicitAny: thin pass-through; the public type is the cast.
  const tool = ((name: string, config: any, cb: any) => {
    const reg = baseRegister(name, config, cb);
    if (selected && !selected.has(name)) reg.disable();
    return reg;
  }) as typeof server.registerTool;

  // Fires on each connection's initialize handshake — i.e. on reconnect. Arm a
  // catch-up so the first query reconciles edits made while disconnected.
  server.server.oninitialized = () => session.markForCatchUp();

  tool(
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

  tool(
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

  tool(
    "sync_index",
    {
      description:
        "Reconcile files that changed on disk since indexing (a manual catch-up). " +
        "Returns the repo-relative paths re-indexed and removed.",
      inputSchema: {},
    },
    tap("sync_index", async () => json(await session.sync())),
  );

  tool(
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
        exact: z
          .boolean()
          .optional()
          .describe(
            "Match the query as a whole symbol name/qualified-name (exact, case-insensitive) " +
              "instead of substring/word search — use for a precise lookup like `Foo.bar`.",
          ),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "search_symbol",
      async ({
        query,
        limit,
        kind,
        exact,
        projectPath,
      }: {
        query: string;
        limit?: number;
        kind?: NodeKind;
        exact?: boolean;
        projectPath?: string;
      }) => {
        await session.catchUpIfNeeded();
        const max = limit ?? DEFAULT_SEARCH_LIMIT;
        const { results, lowConfidence } = session.searchSymbolWithConfidence(
          query,
          { limit: max + 1, kind, exact },
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

  tool(
    "find_callers",
    {
      description:
        "Every place that calls a function or method — each result is " +
        "{ symbol, at: { line, column } } so you see who calls it and where.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_callers",
      relationTool(
        session,
        (a: { symbol: string }) => a.symbol,
        ({ symbol, projectPath }: { symbol: string; projectPath?: string }) =>
          session.findCallers(symbol, projectPath),
      ),
    ),
  );

  tool(
    "find_callees",
    {
      description:
        "What a function or method calls — each result is { symbol, at: { line, column } }, " +
        "the callee and the call site.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_callees",
      relationTool(
        session,
        (a: { symbol: string }) => a.symbol,
        ({ symbol, projectPath }: { symbol: string; projectPath?: string }) =>
          session.findCallees(symbol, projectPath),
      ),
    ),
  );

  tool(
    "find_handlers",
    {
      description: "The handler symbols a framework route maps to.",
      inputSchema: {
        route: z.string().describe('Route id or name, e.g. "GET /users".'),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_handlers",
      queryTool(session, ({ route, projectPath }: { route: string; projectPath?: string }) =>
        session.findHandlers(route, projectPath),
      ),
    ),
  );

  tool(
    "find_routes",
    {
      description: "Every framework route that maps to a symbol (handler).",
      inputSchema: {
        symbol: z.string().describe("Handler symbol id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_routes",
      queryTool(session, ({ symbol, projectPath }: { symbol: string; projectPath?: string }) =>
        session.findRoutes(symbol, projectPath),
      ),
    ),
  );

  tool(
    "find_overrides",
    {
      description:
        "The supertype methods a method overrides or implements (method → the " +
        "interface/base method of the same name).",
      inputSchema: {
        symbol: z.string().describe("Method id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_overrides",
      queryTool(session, ({ symbol, projectPath }: { symbol: string; projectPath?: string }) =>
        session.findOverrides(symbol, projectPath),
      ),
    ),
  );

  tool(
    "find_overridden_by",
    {
      description:
        "The subtype methods that override a method — what breaks if you change this " +
        "interface/base method.",
      inputSchema: {
        symbol: z.string().describe("Method id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_overridden_by",
      queryTool(session, ({ symbol, projectPath }: { symbol: string; projectPath?: string }) =>
        session.findOverriddenBy(symbol, projectPath),
      ),
    ),
  );

  tool(
    "find_referrers",
    {
      description:
        "Everything that references a symbol via a References edge: who reads a module-level " +
        "constant/variable, the routes that map to a handler, and other dispatch references. " +
        "Use this for 'who uses X' when X isn't called (reads aren't calls, so find_callers " +
        "won't see them).",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_referrers",
      queryTool(session, ({ symbol, projectPath }: { symbol: string; projectPath?: string }) =>
        session.findReferrers(symbol, projectPath),
      ),
    ),
  );

  tool(
    "find_implementations",
    {
      description: "Every class that implements an interface.",
      inputSchema: {
        symbol: z.string().describe("Interface id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_implementations",
      relationTool(
        session,
        (a: { symbol: string }) => a.symbol,
        ({ symbol, projectPath }: { symbol: string; projectPath?: string }) =>
          session.findImplementations(symbol, projectPath),
      ),
    ),
  );

  tool(
    "find_interfaces",
    {
      description: "The interfaces a class implements.",
      inputSchema: {
        symbol: z.string().describe("Class id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_interfaces",
      queryTool(session, ({ symbol, projectPath }: { symbol: string; projectPath?: string }) =>
        session.findInterfaces(symbol, projectPath),
      ),
    ),
  );

  tool(
    "find_importers",
    {
      description: "Every file that imports (or re-exports) a symbol.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_importers",
      queryTool(session, ({ symbol, projectPath }: { symbol: string; projectPath?: string }) =>
        session.findImporters(symbol, projectPath),
      ),
    ),
  );

  tool(
    "find_imports",
    {
      description: "The symbols a file imports (or re-exports).",
      inputSchema: {
        file: z.string().describe("File node id (repo-relative path) or basename."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_imports",
      queryTool(session, ({ file, projectPath }: { file: string; projectPath?: string }) =>
        session.findImports(file, projectPath),
      ),
    ),
  );

  tool(
    "find_type_users",
    {
      description: "Every symbol that uses a type in a parameter, return, or property.",
      inputSchema: {
        type: z.string().describe("Type id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_type_users",
      queryTool(session, ({ type, projectPath }: { type: string; projectPath?: string }) =>
        session.findTypeUsers(type, projectPath),
      ),
    ),
  );

  tool(
    "find_types_used",
    {
      description: "The named types a symbol uses in its parameters, return, or properties.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_types_used",
      queryTool(session, ({ symbol, projectPath }: { symbol: string; projectPath?: string }) =>
        session.findTypesUsed(symbol, projectPath),
      ),
    ),
  );

  tool(
    "find_returns",
    {
      description:
        "The named type(s) a function or method returns — the return half of find_types_used.",
      inputSchema: {
        symbol: z.string().describe("Function/method id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "find_returns",
      queryTool(session, ({ symbol, projectPath }: { symbol: string; projectPath?: string }) =>
        session.findReturns(symbol, projectPath),
      ),
    ),
  );

  tool(
    "get_code_snippet",
    {
      description: "A symbol's verbatim source.",
      inputSchema: {
        symbol: z.string().describe("Symbol id, simple name, or dotted qualified name."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "get_code_snippet",
      queryTool(session, ({ symbol, projectPath }: { symbol: string; projectPath?: string }) =>
        session.getCodeSnippet(symbol, projectPath),
      ),
    ),
  );

  tool(
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

  tool(
    "file_skeleton",
    {
      description:
        "A file's outline in one call: the symbols it defines (kind, name, line range) " +
        "plus the files that depend on it — a structured, cheaper alternative to reading " +
        "the whole file.",
      inputSchema: {
        file: z.string().describe("File node id (repo-relative path) or basename."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "file_skeleton",
      queryTool(session, ({ file, projectPath }: { file: string; projectPath?: string }) =>
        session.fileSkeleton(file, projectPath),
      ),
    ),
  );

  tool(
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
        projectPath: projectPathSchema,
      },
    },
    tap(
      "impact_analysis",
      relationTool(
        session,
        (a: { symbol: string }) => a.symbol,
        ({
          symbol,
          maxDepth,
          projectPath,
        }: { symbol: string; maxDepth?: number; projectPath?: string }) =>
          session.impactAnalysis(symbol, maxDepth, projectPath),
      ),
    ),
  );

  tool(
    "get_graph_schema",
    {
      description:
        "A census of the index: how many nodes of each kind and edges of each kind it holds.",
      inputSchema: { projectPath: projectPathSchema },
    },
    tap(
      "get_graph_schema",
      queryTool(session, ({ projectPath }: { projectPath?: string }) =>
        session.getGraphSchema(projectPath),
      ),
    ),
  );

  tool(
    "export_code_intel",
    {
      description:
        "Export the whole index as a portable, SCIP-inspired symbol/occurrence JSON — stable symbol " +
        "ids plus definition/reference occurrences per file — for interop with other code-intelligence tools.",
      inputSchema: { projectPath: projectPathSchema },
    },
    tap(
      "export_code_intel",
      queryTool(session, ({ projectPath }: { projectPath?: string }) =>
        session.codeIntelIndex(projectPath),
      ),
    ),
  );

  tool(
    "circular_imports",
    {
      description:
        "File-level import cycles: groups of two or more files that (transitively) import " +
        "each other. Each group is a strongly-connected component — high-signal for refactoring " +
        "and untangling module graphs. Empty when the import graph is acyclic.",
      inputSchema: { projectPath: projectPathSchema },
    },
    tap(
      "circular_imports",
      queryTool(session, ({ projectPath }: { projectPath?: string }) =>
        session.circularImports(projectPath),
      ),
    ),
  );

  tool(
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
        projectPath: projectPathSchema,
      },
    },
    tap(
      "affected",
      queryTool(
        session,
        ({
          files,
          testsOnly,
          projectPath,
        }: { files: string[]; testsOnly?: boolean; projectPath?: string }) =>
          session.affected(files, { testsOnly }, projectPath),
      ),
    ),
  );

  tool(
    "search_code",
    {
      description:
        "Full-text search over symbol bodies — find code containing a string, not just by name.",
      inputSchema: {
        query: z.string().describe("Text to find inside symbol source (case-insensitive)."),
        limit: z.number().int().positive().optional().describe("Max results."),
        projectPath: projectPathSchema,
      },
    },
    tap(
      "search_code",
      async ({
        query,
        limit,
        projectPath,
      }: { query: string; limit?: number; projectPath?: string }) => {
        await session.catchUpIfNeeded();
        const max = limit ?? DEFAULT_SEARCH_LIMIT;
        const { results, viaTerms } = session.searchCodeWithConfidence(
          query,
          { limit: max + 1 },
          projectPath,
        );
        const termHint = viaTerms
          ? `⚠️ Ama: no symbol body contains the exact phrase "${query}" — these match its words separately and may be unrelated. Search a shorter exact phrase to narrow.`
          : undefined;
        const { shown, hint } = capped(results, max, termHint);
        return reply(session, shown, hint);
      },
    ),
  );

  tool(
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
        projectPath: projectPathSchema,
      },
    },
    tap(
      "explore",
      queryTool(
        session,
        ({
          question,
          limit,
          projectPath,
        }: { question: string; limit?: number; projectPath?: string }) =>
          session.explore(question, { limit }, projectPath),
      ),
    ),
  );

  return server;
}

/** Entry point: serve over stdio. stdout carries JSON-RPC only — log to stderr. */
export async function main(): Promise<void> {
  // Lazily index the launch directory (or AMA_ROOT) on the first query, so an agent that
  // queries before calling index_repository gets a transparent first index, not an error. (#35)
  const session = new AmaSession(undefined, process.env.AMA_ROOT ?? process.cwd());
  const server = createServer(session);
  await server.connect(new StdioServerTransport());
  console.error("ama MCP server running on stdio");
}

if (isEntrypoint(import.meta.url)) {
  // Pin grammar WASM to the baseline compiler before anything loads it, or a
  // long-running index OOMs (ama-rgx). Re-execs once; the supervisor skips main.
  if (!ensureBaselineWasmTier()) {
    main().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
}
