import type { GraphNode } from "../../graph/types.js";
import { emitError } from "../emit.js";
import type { CliCommand } from "../index.js";
import { withQuery } from "../query-runner.js";

/** Render import cycles for the terminal, or `--json` (raw GraphNode[][]). */
export function renderCycles(cycles: GraphNode[][], json: boolean): string {
  if (json) return JSON.stringify(cycles, null, 2);
  if (cycles.length === 0) return "No import cycles found.";
  const lines = [`${cycles.length} import cycle(s):`];
  for (const cycle of cycles) lines.push(`  ${cycle.map((n) => n.file).join(" ↔ ")}`);
  return lines.join("\n");
}

export const cyclesCommand: CliCommand = {
  name: "cycles",
  summary: "List file-level import cycles (strongly-connected components)",
  async run(_args, ctx) {
    const cycles = await withQuery(process.env.AMA_ROOT ?? ".", (query) => query.circularImports());
    if (cycles === undefined) {
      emitError(ctx, "No index found. Run `ama index` first.");
      return 1;
    }
    ctx.write(renderCycles(cycles, ctx.json));
    return 0;
  },
};
