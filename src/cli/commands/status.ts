import * as fs from "node:fs";
import * as path from "node:path";
import { createDefaultIndexer } from "../../indexer/indexer.js";
import { serverStamp } from "../../mcp/build-info.js";
import type { IndexStatus } from "../../mcp/session.js";
import { SqliteStore } from "../../store/sqlite.js";
import type { CliCommand } from "../index.js";
import { dbPathFor } from "../paths.js";

/**
 * Read a persisted index's stats without re-analyzing. Uses {@link Indexer.open}
 * (not {@link AmaSession.open}) so a missing/stale index reports "not indexed"
 * rather than silently triggering a full re-index — `status` reports, it never
 * builds. `pendingSync` is always 0: a one-shot CLI process runs no watcher.
 */
async function loadStatus(root: string, dbPath: string): Promise<IndexStatus> {
  if (!fs.existsSync(dbPath)) return { indexed: false, server: serverStamp };
  const indexer = createDefaultIndexer(() => new SqliteStore(dbPath));
  const opened = await indexer.open(path.resolve(root));
  if (!opened) return { indexed: false, server: serverStamp };
  const { root: r, nodeCount, edgeCount, fileCount, languages } = opened.stats;
  opened.store.close();
  return {
    indexed: true,
    root: r,
    nodeCount,
    edgeCount,
    fileCount,
    languages,
    pendingSync: 0,
    projects: [{ root: r, nodeCount, edgeCount, fileCount }],
    server: serverStamp,
  };
}

/** Render an {@link IndexStatus} for the terminal (human lines) or `--json`. */
export function renderStatus(status: IndexStatus, json: boolean): string {
  if (json) return JSON.stringify(status, null, 2);
  const rev = status.server.revision?.slice(0, 7) ?? "unknown";
  const stamp = `ama ${status.server.version} (${rev})`;
  if (!status.indexed) {
    return ["No index found. Run `ama index` to build one.", `server: ${stamp}`].join("\n");
  }
  const lines = [
    `Index: ${status.root}`,
    `  ${status.fileCount} files · ${status.nodeCount} nodes · ${status.edgeCount} edges`,
  ];
  for (const lang of status.languages) {
    lines.push(`  ${lang.language}  ${lang.tier}  ${lang.files} files`);
  }
  lines.push(`  pending sync: ${status.pendingSync}`, `server: ${stamp}`);
  return lines.join("\n");
}

export const statusCommand: CliCommand = {
  name: "status",
  summary: "Show index statistics and pending-sync info",
  async run(args, ctx) {
    const root = args[0] ?? process.env.AMA_ROOT ?? ".";
    const status = await loadStatus(root, dbPathFor(root));
    ctx.write(renderStatus(status, ctx.json));
    return 0;
  },
};
