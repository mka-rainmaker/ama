import * as fs from "node:fs";
import * as path from "node:path";
import { type GraphNode, NODE_KINDS, type NodeKind } from "../../graph/types.js";
import { createDefaultIndexer } from "../../indexer/indexer.js";
import { QueryService, type SearchResult } from "../../query/service.js";
import { SqliteStore } from "../../store/sqlite.js";
import { emitError } from "../emit.js";
import type { CliCommand } from "../index.js";
import { dbPathFor } from "../paths.js";
import { withQuery } from "../query-runner.js";

const USAGE =
  "Usage: ama search <query> [--kind <Kind>] [--limit <N>]\n" +
  "  query may include inline filters: path:src/api kind:Function lang:python name:handler";

/** Result of parsing `search` arguments: the query plus filters, or an error. */
export interface SearchArgs {
  query?: string;
  kind?: NodeKind;
  limit?: number;
  error?: string;
}

/**
 * Parse `search` positionals/flags. Returns `{ error }` (not a throw) on bad
 * input so the command can print usage and exit 1; `--kind` is validated against
 * {@link NODE_KINDS}, the single source of truth shared with the MCP schema.
 */
export function parseSearchArgs(args: string[]): SearchArgs {
  let query: string | undefined;
  let kind: NodeKind | undefined;
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--kind") {
      const value = args[i + 1];
      i++;
      if (value === undefined) return { error: "--kind requires a value" };
      if (!(NODE_KINDS as readonly string[]).includes(value)) {
        return { error: `unknown --kind: ${value} (expected one of ${NODE_KINDS.join(", ")})` };
      }
      kind = value as NodeKind;
    } else if (arg === "--limit") {
      const value = args[i + 1];
      i++;
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) return { error: "--limit requires a positive integer" };
      limit = n;
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag: ${arg}` };
    } else if (query === undefined) {
      query = arg;
    } else {
      return { error: `unexpected argument: ${arg}` };
    }
  }
  return { query, kind, limit };
}

/** Render search hits for the terminal, or `--json` (the raw node array).
 *  `lowConfidence` appends a refine-the-query nudge in human mode (ama-b79). */
export function renderSearch(
  query: string,
  nodes: GraphNode[],
  json: boolean,
  lowConfidence = false,
): string {
  if (json) return JSON.stringify(nodes, null, 2);
  if (nodes.length === 0) return `No symbols match "${query}".`;
  const lines = [`${nodes.length} result${nodes.length === 1 ? "" : "s"} for "${query}":`];
  for (const node of nodes) {
    const where = node.range ? `${node.file}:${node.range.startLine}` : node.file;
    const label = node.qualifiedName || node.name;
    lines.push(`  ${node.kind.padEnd(10)} ${label}  ${where}  [${node.tier}]`);
  }
  if (lowConfidence) {
    lines.push("  ⚠️  no exact or prefix match — loose substring hits; refine the query.");
  }
  return lines.join("\n");
}

/**
 * Open the persisted index read-only and run the query. Returns `undefined`
 * (not `[]`) when there is no usable index, so the command can distinguish
 * "no index" from "indexed, zero matches".
 */
async function runSearch(root: string, opts: SearchArgs): Promise<SearchResult | undefined> {
  const dbPath = dbPathFor(root);
  if (!fs.existsSync(dbPath)) return undefined;
  const abs = path.resolve(root);
  const indexer = createDefaultIndexer(() => new SqliteStore(dbPath));
  const opened = await indexer.open(abs);
  if (!opened) return undefined;
  try {
    return new QueryService(opened.store, abs).searchSymbolWithConfidence(opts.query ?? "", {
      kind: opts.kind,
      limit: opts.limit,
    });
  } finally {
    opened.store.close();
  }
}

export const searchCommand: CliCommand = {
  name: "search",
  summary: "Find symbols by name, with inline path:/kind:/lang:/name: filters",
  usage: USAGE,
  async run(args, ctx) {
    const parsed = parseSearchArgs(args);
    if (parsed.error !== undefined || parsed.query === undefined) {
      emitError(ctx, parsed.error ? `${parsed.error}\n${USAGE}` : USAGE);
      return 1;
    }
    const root = process.env.AMA_ROOT ?? ".";
    const hit = await runSearch(root, parsed);
    if (hit === undefined) {
      emitError(ctx, "No index found. Run `ama index` first.");
      return 1;
    }
    ctx.write(renderSearch(parsed.query, hit.results, ctx.json, hit.lowConfidence));
    return 0;
  },
};

export const searchCodeCommand: CliCommand = {
  name: "search-code",
  summary: "Find symbols whose body text contains a string",
  usage: "Usage: ama search-code <text> [--limit <N>]",
  async run(args, ctx) {
    let limit: number | undefined;
    const terms: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;
      if (arg === "--limit") {
        const value = args[i + 1];
        i++;
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          emitError(ctx, "--limit requires a positive integer");
          return 1;
        }
        limit = n;
      } else if (arg.startsWith("--")) {
        emitError(ctx, `unknown flag: ${arg}`);
        return 1;
      } else {
        terms.push(arg);
      }
    }
    const query = terms.join(" ");
    if (query === "") {
      emitError(ctx, "Usage: ama search-code <text> [--limit <N>]");
      return 1;
    }
    const hits = await withQuery(process.env.AMA_ROOT ?? ".", (q) =>
      q.searchCode(query, { limit }),
    );
    if (hits === undefined) {
      emitError(ctx, "No index found. Run `ama index` first.");
      return 1;
    }
    ctx.write(renderSearch(query, hits, ctx.json));
    return 0;
  },
};
