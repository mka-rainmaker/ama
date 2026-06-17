import type { FileMeta } from "../../store/types.js";
import type { CliCommand } from "../index.js";
import { withQuery } from "../query-runner.js";

/** Render the indexed-file list for the terminal, or `--json` (raw FileMeta[]). */
export function renderFiles(files: FileMeta[], filter: string | undefined, json: boolean): string {
  if (json) return JSON.stringify(files, null, 2);
  if (files.length === 0) {
    return filter ? `No files match "${filter}".` : "No indexed files.";
  }
  const suffix = filter ? ` matching "${filter}"` : "";
  const lines = [`${files.length} file(s)${suffix}:`];
  for (const file of files) lines.push(`  ${file.path}`);
  return lines.join("\n");
}

export const filesCommand: CliCommand = {
  name: "files",
  summary: "List indexed files, optionally filtered by a path substring",
  async run(args, ctx) {
    const filter = args[0];
    const all = await withQuery(process.env.AMA_ROOT ?? ".", (query) => query.files());
    if (all === undefined) {
      ctx.write("No index found. Run `ama index` first.");
      return 1;
    }
    const files = filter
      ? all.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()))
      : all;
    ctx.write(renderFiles(files, filter, ctx.json));
    return 0;
  },
};
