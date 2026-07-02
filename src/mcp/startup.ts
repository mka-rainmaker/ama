import * as fs from "node:fs";
import * as path from "node:path";
import { createDefaultIndexer } from "../indexer/indexer.js";
import { InMemoryStore } from "../store/memory.js";
import { SqliteStore } from "../store/sqlite.js";
import type { Store } from "../store/types.js";
import { AmaSession, type IndexStatus } from "./session.js";

type StartupEnv = {
  AMA_DB?: string;
  AMA_ROOT?: string;
};

export type IndexedStatus = Extract<IndexStatus, { indexed: true }>;

export interface StartupSession {
  session: AmaSession;
  root: string;
}

export interface ReadyStartupSession extends StartupSession {
  status: IndexedStatus;
}

/**
 * The project Ama should serve at process startup. AMA_ROOT is explicit; otherwise
 * MCP clients normally launch the server with the project root as cwd.
 */
export function startupRoot(
  env: Pick<StartupEnv, "AMA_ROOT"> = process.env,
  cwd = process.cwd(),
): string {
  return path.resolve(env.AMA_ROOT || cwd);
}

/**
 * Build the long-lived MCP session with the same storage policy for every
 * transport: AMA_DB persists the startup root, while extra indexed projects get
 * isolated in-memory stores so their graphs cannot alias the persisted DB.
 */
export function createStartupSession(
  env: StartupEnv = process.env,
  cwd = process.cwd(),
): StartupSession {
  const root = startupRoot(env, cwd);
  const dbPath = env.AMA_DB;
  if (!dbPath) return { session: new AmaSession(undefined, root), root };

  const db = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const persisted = root;
  const createStore = (projectRoot: string): Store =>
    projectRoot === persisted ? new SqliteStore(db) : new InMemoryStore();
  return { session: new AmaSession(createDefaultIndexer(createStore), root), root };
}

/**
 * Open or build the startup root before serving MCP tools. When a persisted DB is
 * reopened, reconcile drift immediately so `index_status` and the first query are
 * current without an explicit `index_repository` command.
 */
export async function prepareStartupSession(
  env: StartupEnv = process.env,
  cwd = process.cwd(),
): Promise<ReadyStartupSession> {
  const started = createStartupSession(env, cwd);
  await started.session.open(started.root);
  await started.session.catchUpIfNeeded();
  const status = started.session.indexStatus();
  if (!status.indexed) {
    throw new Error(`Startup index did not initialize for ${started.root}`);
  }
  return { ...started, status };
}
