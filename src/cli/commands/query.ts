import type { GraphNode } from "../../graph/types.js";
import type { Exploration, NodeView, QueryService } from "../../query/service.js";
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
  return [
    nodeLine(view.node).trimStart(),
    `  callers (${view.callers.length}): ${names(view.callers)}`,
    `  callees (${view.callees.length}): ${names(view.callees)}`,
    `  dependents (${view.dependents.length}): ${names(view.dependents)}`,
  ].join("\n");
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
  q.findCallers(ref),
);

export const calleesCommand = refQueryCommand("callees", "List what a symbol calls", (q, ref) =>
  q.findCallees(ref),
);

export const nodeCommand: CliCommand = {
  name: "node",
  summary: "Show a symbol with its callers, callees, and dependents",
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

export const exploreCommand: CliCommand = {
  name: "explore",
  summary: "Explore symbols matching a question and their blast radius",
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
