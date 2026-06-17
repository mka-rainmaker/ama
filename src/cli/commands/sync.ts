import * as fs from "node:fs";
import * as path from "node:path";
import { type SyncResult, createDefaultIndexer } from "../../indexer/indexer.js";
import { SqliteStore } from "../../store/sqlite.js";
import { emitError } from "../emit.js";
import type { CliCommand } from "../index.js";
import { dbPathFor } from "../paths.js";

/** Render a {@link SyncResult} for the terminal, or `--json` (the raw result). */
export function renderSync(result: SyncResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);
  if (result.changed.length === 0 && result.removed.length === 0) {
    return "Already up to date.";
  }
  const lines = [`Synced: ${result.changed.length} changed, ${result.removed.length} removed.`];
  for (const file of result.changed) lines.push(`  ~ ${file}`);
  for (const file of result.removed) lines.push(`  - ${file}`);
  return lines.join("\n");
}

/**
 * Open the persisted index and reconcile it with on-disk changes in place.
 * Returns `undefined` when there is no usable index (so the command can say
 * "run `ama index`" rather than building one) — `sync` is incremental and
 * presupposes an existing index, unlike `index` which rebuilds from scratch.
 */
async function runSync(root: string): Promise<SyncResult | undefined> {
  const dbPath = dbPathFor(root);
  if (!fs.existsSync(dbPath)) return undefined;
  const abs = path.resolve(root);
  const indexer = createDefaultIndexer(() => new SqliteStore(dbPath));
  const opened = await indexer.open(abs);
  if (!opened) return undefined;
  try {
    return await indexer.sync(opened.store, abs);
  } finally {
    opened.store.close();
  }
}

export const syncCommand: CliCommand = {
  name: "sync",
  summary: "Incrementally reconcile the index with on-disk changes",
  async run(args, ctx) {
    const root = args[0] ?? process.env.AMA_ROOT ?? ".";
    const result = await runSync(root);
    if (result === undefined) {
      emitError(ctx, "No index found. Run `ama index` first.");
      return 1;
    }
    ctx.write(renderSync(result, ctx.json));
    return 0;
  },
};
