import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the module at `importMetaUrl` is the process entry point — robust to a
 * symlinked launcher. npm installs a `bin` as a symlink (`.bin/ama` → the real
 * `dist/cli/index.js`), so `process.argv[1]` is the symlink path while `import.meta.url`
 * is the resolved real file; a raw `argv[1] === fileURLToPath(import.meta.url)` check is
 * then false for an installed bin and the program silently no-ops. Comparing the resolved
 * realpaths of both fixes it (and is correct for a direct `node dist/…` invocation too).
 * (ama-8fa)
 */
export function isEntrypoint(
  importMetaUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false; // a path that doesn't exist on disk can't be the entry point
  }
}
