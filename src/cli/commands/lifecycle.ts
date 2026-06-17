import * as fs from "node:fs";
import * as path from "node:path";
import { createDefaultIndexer } from "../../indexer/indexer.js";
import { AmaSession, type IndexStatus } from "../../mcp/session.js";
import { SqliteStore } from "../../store/sqlite.js";
import type { CliCommand } from "../index.js";
import { dbPathFor } from "../paths.js";
import { renderStatus } from "./status.js";

/** Resolve the project root from args/env, defaulting to the cwd. */
function rootFrom(args: string[]): string {
  return args[0] ?? process.env.AMA_ROOT ?? ".";
}

/**
 * Build (or rebuild) a persistent index at `dbPath` and return its status. The
 * indexer is storage-agnostic — injecting a {@link SqliteStore} factory is what
 * makes the build persist; {@link AmaSession.indexRepository} clears and
 * repopulates an existing store, so a rebuild overwrites in place.
 */
async function buildIndex(root: string, dbPath: string): Promise<IndexStatus> {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const session = new AmaSession(createDefaultIndexer(() => new SqliteStore(dbPath)));
  try {
    await session.indexRepository(root);
    return session.indexStatus();
  } finally {
    session.close();
  }
}

/** Delete an index's db file and any SQLite sidecars; report whether anything was removed. */
function removeIndex(dbPath: string): boolean {
  let removed = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = dbPath + suffix;
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed = true;
    }
  }
  return removed;
}

export const indexCommand: CliCommand = {
  name: "index",
  summary: "Build or rebuild the project index",
  async run(args, ctx) {
    const root = rootFrom(args);
    const status = await buildIndex(root, dbPathFor(root));
    ctx.write(renderStatus(status, ctx.json));
    return 0;
  },
};

export const initCommand: CliCommand = {
  name: "init",
  summary: "Build the project index (no-op if one already exists)",
  async run(args, ctx) {
    const root = rootFrom(args);
    const dbPath = dbPathFor(root);
    if (fs.existsSync(dbPath)) {
      ctx.write(
        ctx.json
          ? JSON.stringify({ alreadyInitialized: true, dbPath }, null, 2)
          : `Already initialized at ${dbPath}. Run \`ama index\` to rebuild.`,
      );
      return 0;
    }
    const status = await buildIndex(root, dbPath);
    ctx.write(renderStatus(status, ctx.json));
    return 0;
  },
};

export const uninitCommand: CliCommand = {
  name: "uninit",
  summary: "Remove the project index",
  run(args, ctx) {
    const root = rootFrom(args);
    const dbPath = dbPathFor(root);
    const removed = removeIndex(dbPath);
    ctx.write(
      ctx.json
        ? JSON.stringify({ removed, dbPath }, null, 2)
        : removed
          ? `Removed index at ${dbPath}.`
          : `No index to remove at ${dbPath}.`,
    );
    return 0;
  },
};
