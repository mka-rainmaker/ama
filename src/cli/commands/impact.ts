import type { GraphNode } from "../../graph/types.js";
import { emitError } from "../emit.js";
import type { CliCommand } from "../index.js";
import { withQuery } from "../query-runner.js";
import { nodeLine, renderNodeList } from "./query.js";

const NO_INDEX = "No index found. Run `ama index` first.";

/** Result of parsing `impact` arguments: the ref and an optional depth bound. */
export interface ImpactArgs {
  ref?: string;
  depth?: number;
  error?: string;
}

/** Parse `impact <symbol> [--depth <N>]`; returns `{ error }` on bad input. */
export function parseImpactArgs(args: string[]): ImpactArgs {
  let ref: string | undefined;
  let depth: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--depth") {
      const value = args[i + 1];
      i++;
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) return { error: "--depth requires a positive integer" };
      depth = n;
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag: ${arg}` };
    } else if (ref === undefined) {
      ref = arg;
    } else {
      return { error: `unexpected argument: ${arg}` };
    }
  }
  return depth === undefined ? { ref } : { ref, depth };
}

/** Render the `affected` result: importers impacted by a change to `refs`. */
export function renderAffected(refs: string[], nodes: GraphNode[], json: boolean): string {
  if (json) return JSON.stringify(nodes, null, 2);
  const subject = refs.join(", ");
  if (nodes.length === 0) return `Nothing is affected by ${subject}.`;
  const lines = [`${nodes.length} symbol(s) affected by ${subject}:`];
  for (const node of nodes) lines.push(nodeLine(node));
  return lines.join("\n");
}

export const impactCommand: CliCommand = {
  name: "impact",
  summary: "Show the blast radius (transitive callers) of a symbol",
  usage: "Usage: ama impact <symbol> [--depth <N>]",
  async run(args, ctx) {
    const parsed = parseImpactArgs(args);
    const ref = parsed.ref;
    if (parsed.error !== undefined || ref === undefined) {
      const usage = "Usage: ama impact <symbol> [--depth <N>]";
      emitError(ctx, parsed.error ? `${parsed.error}\n${usage}` : usage);
      return 1;
    }
    const nodes = await withQuery(process.env.AMA_ROOT ?? ".", (query) =>
      query.impactAnalysis(ref, parsed.depth),
    );
    if (nodes === undefined) {
      emitError(ctx, NO_INDEX);
      return 1;
    }
    ctx.write(renderNodeList("impacted symbols", ref, nodes, ctx.json));
    return 0;
  },
};

export const affectedCommand: CliCommand = {
  name: "affected",
  summary: "Show files impacted by changes to the given files",
  usage: "Usage: ama affected <file> [file...]",
  async run(args, ctx) {
    if (args.length === 0) {
      emitError(ctx, "Usage: ama affected <file> [file...]");
      return 1;
    }
    const nodes = await withQuery(process.env.AMA_ROOT ?? ".", (query) => query.affected(args));
    if (nodes === undefined) {
      emitError(ctx, NO_INDEX);
      return 1;
    }
    ctx.write(renderAffected(args, nodes, ctx.json));
    return 0;
  },
};
