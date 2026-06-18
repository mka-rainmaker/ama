import type { GraphNode } from "../../graph/types.js";
import type { Exploration, FileSkeleton, NodeView, QueryService } from "../../query/service.js";
import { emitError } from "../emit.js";
import type { CliCommand } from "../index.js";
import { withQuery } from "../query-runner.js";

const NO_INDEX = "No index found. Run `ama index` first.";

/** One compact line per node: kind, qualified name, location, tier. */
export function nodeLine(node: GraphNode): string {
  const where = node.range ? `${node.file}:${node.range.startLine}` : node.file;
  return `  ${node.kind.padEnd(10)} ${node.qualifiedName || node.name}  ${where}  [${node.tier}]`;
}

/** Comma-separated qualified names, for the compact relationship summaries. */
function names(nodes: GraphNode[]): string {
  return nodes.map((n) => n.qualifiedName || n.name).join(", ");
}

/** Render a node list (callers/callees) for the terminal, or `--json`. */
export function renderNodeList(
  label: string,
  ref: string,
  nodes: GraphNode[],
  json: boolean,
): string {
  if (json) return JSON.stringify(nodes, null, 2);
  if (nodes.length === 0) return `No ${label} found for "${ref}".`;
  const lines = [`${nodes.length} ${label} of "${ref}":`];
  for (const node of nodes) lines.push(nodeLine(node));
  return lines.join("\n");
}

/** Render a {@link NodeView} (the `node` command) for the terminal, or `--json`. */
export function renderNodeView(view: NodeView, json: boolean): string {
  if (json) return JSON.stringify(view, null, 2);
  const lines = [nodeLine(view.node).trimStart()];
  // The symbol's own source — the point of a single-symbol detail view.
  if (view.snippet) lines.push("", view.snippet.text, "");
  lines.push(
    `  callers (${view.callers.length}): ${names(view.callers)}`,
    `  callees (${view.callees.length}): ${names(view.callees)}`,
    `  referrers (${view.referrers.length}): ${names(view.referrers)}`,
    `  dependents (${view.dependents.length}): ${names(view.dependents)}`,
  );
  return lines.join("\n");
}

/** Render a {@link FileSkeleton} (the `skeleton` command) for the terminal, or `--json`. */
export function renderFileSkeleton(skeleton: FileSkeleton, json: boolean): string {
  if (json) return JSON.stringify(skeleton, null, 2);
  const lines = [
    `${skeleton.file.file} — ${skeleton.symbols.length} symbol(s), ` +
      `${skeleton.dependents.length} dependent(s)`,
  ];
  for (const sym of skeleton.symbols) lines.push(nodeLine(sym));
  lines.push(`  dependents (${skeleton.dependents.length}): ${names(skeleton.dependents)}`);
  return lines.join("\n");
}

/** Render an {@link Exploration} (the `explore` command) for the terminal, or `--json`. */
export function renderExploration(exploration: Exploration, json: boolean): string {
  if (json) return JSON.stringify(exploration, null, 2);
  const files = Object.entries(exploration.byFile);
  const lines = [`Exploring "${exploration.question}" — matches in ${files.length} file(s):`];
  for (const [file, nodes] of files) lines.push(`  ${file}: ${names(nodes)}`);
  lines.push(`blast radius: ${exploration.blastRadius.length} symbol(s)`);
  return lines.join("\n");
}

/** Build a `callers`/`callees`-style command from the QueryService method it wraps. */
function refQueryCommand(
  name: string,
  summary: string,
  pick: (query: QueryService, ref: string) => GraphNode[],
): CliCommand {
  return {
    name,
    summary,
    usage: `Usage: ama ${name} <symbol>`,
    async run(args, ctx) {
      const ref = args[0];
      if (ref === undefined) {
        emitError(ctx, `Usage: ama ${name} <symbol>`);
        return 1;
      }
      const nodes = await withQuery(process.env.AMA_ROOT ?? ".", (query) => pick(query, ref));
      if (nodes === undefined) {
        emitError(ctx, NO_INDEX);
        return 1;
      }
      ctx.write(renderNodeList(name, ref, nodes, ctx.json));
      return 0;
    },
  };
}

export const callersCommand = refQueryCommand("callers", "List the callers of a symbol", (q, ref) =>
  q.findCallers(ref).map((c) => c.symbol),
);

export const calleesCommand = refQueryCommand("callees", "List what a symbol calls", (q, ref) =>
  q.findCallees(ref).map((c) => c.symbol),
);

export const implementationsCommand = refQueryCommand(
  "implementations",
  "List classes that implement an interface",
  (q, ref) => q.findImplementations(ref),
);

export const interfacesCommand = refQueryCommand(
  "interfaces",
  "List interfaces a class implements",
  (q, ref) => q.findInterfaces(ref),
);

export const importersCommand = refQueryCommand(
  "importers",
  "List files that import a file or symbol",
  (q, ref) => q.findImporters(ref),
);

export const importsCommand = refQueryCommand("imports", "List what a file imports", (q, ref) =>
  q.findImports(ref),
);

export const typeUsersCommand = refQueryCommand(
  "type-users",
  "List symbols that use a type",
  (q, ref) => q.findTypeUsers(ref),
);

export const typesUsedCommand = refQueryCommand(
  "types-used",
  "List the types a symbol uses",
  (q, ref) => q.findTypesUsed(ref),
);

export const handlersCommand = refQueryCommand(
  "handlers",
  "List the handler(s) a route maps to",
  (q, ref) => q.findHandlers(ref),
);

export const routesCommand = refQueryCommand(
  "routes",
  "List the routes that map to a symbol",
  (q, ref) => q.findRoutes(ref),
);

export const referrersCommand = refQueryCommand(
  "referrers",
  "List everything that references a symbol (variable readers, routes, dispatch)",
  (q, ref) => q.findReferrers(ref),
);

export const nodeCommand: CliCommand = {
  name: "node",
  summary: "Show a symbol with its callers, callees, and dependents",
  usage: "Usage: ama node <symbol>",
  async run(args, ctx) {
    const ref = args[0];
    if (ref === undefined) {
      emitError(ctx, "Usage: ama node <symbol>");
      return 1;
    }
    // Wrap so the outer undefined ("no index") stays distinct from node()'s own
    // undefined ("symbol not found").
    const result = await withQuery(process.env.AMA_ROOT ?? ".", (query) => ({
      view: query.node(ref),
    }));
    if (result === undefined) {
      emitError(ctx, NO_INDEX);
      return 1;
    }
    if (result.view === undefined) {
      emitError(ctx, `Symbol not found: ${ref}`);
      return 1;
    }
    ctx.write(renderNodeView(result.view, ctx.json));
    return 0;
  },
};

export const skeletonCommand: CliCommand = {
  name: "skeleton",
  summary: "Show a file's symbol outline and the files that depend on it",
  usage: "Usage: ama skeleton <file>",
  async run(args, ctx) {
    const ref = args[0];
    if (ref === undefined) {
      emitError(ctx, "Usage: ama skeleton <file>");
      return 1;
    }
    // Wrap so the outer undefined ("no index") stays distinct from
    // fileSkeleton()'s own undefined ("file not found").
    const result = await withQuery(process.env.AMA_ROOT ?? ".", (query) => ({
      skeleton: query.fileSkeleton(ref),
    }));
    if (result === undefined) {
      emitError(ctx, NO_INDEX);
      return 1;
    }
    if (result.skeleton === undefined) {
      emitError(ctx, `File not found: ${ref}`);
      return 1;
    }
    ctx.write(renderFileSkeleton(result.skeleton, ctx.json));
    return 0;
  },
};

export const exploreCommand: CliCommand = {
  name: "explore",
  summary: "Explore symbols matching a question and their blast radius",
  usage: "Usage: ama explore <question>",
  async run(args, ctx) {
    const question = args.join(" ").trim();
    if (question === "") {
      emitError(ctx, "Usage: ama explore <question>");
      return 1;
    }
    const exploration = await withQuery(process.env.AMA_ROOT ?? ".", (query) =>
      query.explore(question),
    );
    if (exploration === undefined) {
      emitError(ctx, NO_INDEX);
      return 1;
    }
    ctx.write(renderExploration(exploration, ctx.json));
    return 0;
  },
};
