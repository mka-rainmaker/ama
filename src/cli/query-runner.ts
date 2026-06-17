import * as fs from "node:fs";
import * as path from "node:path";
import { createDefaultIndexer } from "../indexer/indexer.js";
import { QueryService } from "../query/service.js";
import { SqliteStore } from "../store/sqlite.js";
import { dbPathFor } from "./paths.js";

/**
 * Open the persisted index read-only, run `fn` against a {@link QueryService},
 * and close. Returns `undefined` when there is no usable index (callers map that
 * to "run `ama index`"). The single open/close path shared by the read-query
 * commands — `Indexer.open` does not fall back to a full build on a miss.
 *
 * Note the `undefined` here means "no index", which can collide with a query
 * that itself returns `undefined` (e.g. `node` on a missing symbol). Wrap such
 * results in an object so the two cases stay distinguishable.
 */
export async function withQuery<T>(
  root: string,
  fn: (query: QueryService) => T,
): Promise<T | undefined> {
  const dbPath = dbPathFor(root);
  if (!fs.existsSync(dbPath)) return undefined;
  const abs = path.resolve(root);
  const indexer = createDefaultIndexer(() => new SqliteStore(dbPath));
  const opened = await indexer.open(abs);
  if (!opened) return undefined;
  try {
    return fn(new QueryService(opened.store, abs));
  } finally {
    opened.store.close();
  }
}
