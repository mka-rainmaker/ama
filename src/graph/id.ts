/**
 * Stable, location-independent identifiers for graph symbols.
 *
 * An id is derived from *where a symbol lives in the module namespace* (file +
 * dotted qualified name), never from its byte offset or line. Moving a function
 * within its file therefore keeps its id — which is what lets the graph survive
 * incremental edits without re-linking every edge.
 */

export interface SymbolLocation {
  /** Repo-relative file path, e.g. "src/a.ts". */
  file: string;
  /** Dotted qualified name within the file, e.g. "Cls.method" or "foo". */
  qualifiedName: string;
}

/** Stable id for a symbol node (function, method, class, …). */
export function symbolId(loc: SymbolLocation): string {
  return `${loc.file}#${loc.qualifiedName}`;
}

/** Stable id for a File node — the repo-relative path itself. */
export function fileId(file: string): string {
  return file;
}
