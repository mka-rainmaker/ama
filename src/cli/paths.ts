import * as path from "node:path";

/**
 * Where a project's persisted index lives by default, mirroring `serve:dev`:
 * the `AMA_DB` env var wins, else `<root>/.ama/index.db`. Shared by every CLI
 * command that opens or builds the index.
 */
export function dbPathFor(root: string): string {
  return process.env.AMA_DB ?? path.join(path.resolve(root), ".ama", "index.db");
}
