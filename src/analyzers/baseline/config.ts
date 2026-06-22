import * as path from "node:path";

/** The repo-relative parent directory of a repo-relative path, with the repo root as
 *  `""` (not `"."`). */
export function parentDir(rel: string): string {
  const p = path.posix.dirname(rel);
  return p === "." ? "" : p;
}

/**
 * The nearest project-config file at or above `dirRel` (walking up to the index root),
 * parsed by `read` into a value, paired with the repo-relative directory it was found in
 * — so a baseline analyzer resolves imports whether the index root *is* the package or
 * merely contains it (a monorepo / Ama's own fixtures). `read(absDir)` returns the parsed
 * config for that directory or `undefined` if there's none there. Results (including
 * "none found") are memoized in `cache` per absolute directory, so a package isn't
 * re-walked once per import. Shared by Go (`go.mod`), PHP (`composer.json`), and C#
 * (`.csproj`). (ama-9yu, ama-x96, ama-66z)
 */
export function nearestConfig<T>(
  root: string,
  dirRel: string,
  read: (absDir: string) => T | undefined,
  cache: Map<string, { dir: string; value: T } | null>,
): { dir: string; value: T } | null {
  const absDir = path.join(root, dirRel);
  const cached = cache.get(absDir);
  if (cached !== undefined) return cached;
  let result: { dir: string; value: T } | null = null;
  const value = read(absDir);
  if (value !== undefined) result = { dir: dirRel, value };
  else if (dirRel !== "" && dirRel !== ".")
    result = nearestConfig(root, parentDir(dirRel), read, cache);
  cache.set(absDir, result);
  return result;
}
