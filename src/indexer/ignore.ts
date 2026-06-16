import * as path from "node:path";

/**
 * Directories never worth indexing or watching. Dot-entries (`.git`, `.beads`,
 * `.vscode`, …) are skipped separately. Shared by the indexer's file discovery
 * and the file watcher so the set of files we *watch* matches what we *index*.
 */
export const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

/** Whether a single path segment (a file or directory name) is ignored. */
export function isIgnoredSegment(name: string): boolean {
  return name.startsWith(".") || IGNORED_DIRS.has(name);
}

/** Whether any segment of a repo-relative path is ignored. */
export function isIgnoredPath(rel: string): boolean {
  return rel.split(path.sep).some(isIgnoredSegment);
}
