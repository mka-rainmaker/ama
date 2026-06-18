import * as path from "node:path";

/**
 * Directories never worth indexing or watching. Dot-entries (`.git`, `.beads`,
 * `.vscode`, …) are skipped separately. Shared by the indexer's file discovery
 * and the file watcher so the set of files we *watch* matches what we *index*.
 */
export const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

/**
 * Files larger than this are skipped by both discovery and the watcher — a
 * minified bundle or data blob isn't worth parsing and risks a memory blowup.
 * Shared so the initial index and the watcher agree on what's too big; without
 * it a huge file would be indexed on first build but skipped on re-index.
 */
export const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB

/** Whether a single path segment (a file or directory name) is ignored. */
export function isIgnoredSegment(name: string): boolean {
  return name.startsWith(".") || IGNORED_DIRS.has(name);
}

/** Whether any segment of a repo-relative path is ignored. */
export function isIgnoredPath(rel: string): boolean {
  return rel.split(path.sep).some(isIgnoredSegment);
}
