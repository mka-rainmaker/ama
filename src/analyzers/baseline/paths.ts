import * as path from "node:path";

/** Ancestor directories of a repo-relative file, closest first, ending at the repo
 *  root (""). The importer's own directory is first. Shared by the baseline import
 *  resolvers that locate a package/namespace directory or a source root relative to
 *  the importing file rather than the index root (Java, C#, Kotlin). (ama-mgn) */
export function ancestorDirs(rel: string): string[] {
  const dirs: string[] = [];
  let dir = path.posix.dirname(rel);
  while (true) {
    dirs.push(dir === "." ? "" : dir);
    if (dir === "." || dir === "") break;
    dir = path.posix.dirname(dir);
  }
  return dirs;
}
