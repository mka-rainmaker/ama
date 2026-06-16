import * as fs from "node:fs";
import * as path from "node:path";
import { isIgnoredPath } from "./ignore.js";

const ONE_MB = 1024 * 1024;

export interface FileWatcherOptions {
  /** Files larger than this are not reported (default 1 MB). */
  maxFileSizeBytes?: number;
}

/**
 * Recursively watches a directory and reports each file that changes, as a
 * repo-relative path, applying the same ignore rules as the indexer (dot-paths,
 * `node_modules`/`dist`/… , and files over a size cap). It does *not* classify
 * create vs. modify vs. delete — the consumer re-indexes the path and lets the
 * indexer decide (a vanished file is reconciled away). Debouncing bursts of
 * edits is a separate concern (ama-gd5.3); this emits raw change events.
 *
 * Built on Node's native `fs.watch` to avoid a dependency. Recursive watching
 * is supported on macOS and Windows; on Linux the recursive option may not be
 * available, in which case this watches only the top level.
 */
export class FileWatcher {
  private watcher?: fs.FSWatcher;
  private readonly maxFileSizeBytes: number;

  constructor(
    private readonly root: string,
    private readonly onChange: (rel: string) => void,
    options: FileWatcherOptions = {},
  ) {
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? ONE_MB;
  }

  start(): void {
    if (this.watcher) return;
    this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
      if (filename === null) return;
      this.handle(filename.toString());
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private handle(rel: string): void {
    if (isIgnoredPath(rel)) return;
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(path.join(this.root, rel));
    } catch {
      // The path is gone (a deletion) — still report it so the consumer can drop it.
      this.onChange(rel);
      return;
    }
    // A directory event or an oversized file is not something to re-index.
    if (!stat.isFile() || stat.size > this.maxFileSizeBytes) return;
    this.onChange(rel);
  }
}
