import * as fs from "node:fs";
import * as path from "node:path";
import {
  type IgnoreRules,
  MAX_FILE_SIZE_BYTES,
  isIgnoredPath,
  loadIgnoreRules,
  withNestedIgnore,
} from "./ignore.js";

/**
 * How a {@link FileWatcher} receives raw change events: given the root and a
 * callback, wire up event delivery and return a handle to stop it. Injectable
 * so tests can drive events synchronously instead of waiting on OS file-event
 * latency (the source of flaky timing tests); the default is {@link fsWatchSource}.
 */
export type WatchSource = (root: string, onEvent: (rel: string) => void) => { close(): void };

/** The production source: Node's native recursive `fs.watch`. */
const fsWatchSource: WatchSource = (root, onEvent) => {
  const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
    if (filename !== null) onEvent(filename.toString());
  });
  return { close: () => watcher.close() };
};

export interface FileWatcherOptions {
  /** Files larger than this are not reported (default 1 MB). */
  maxFileSizeBytes?: number;
  /** Event source (default: fs.watch). Tests inject a synchronous source. */
  source?: WatchSource;
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
  private subscription?: { close(): void };
  private readonly maxFileSizeBytes: number;
  private readonly source: WatchSource;
  /** Loaded once so the watched set matches what the index built (incl .gitignore). */
  private readonly ignoreRules: IgnoreRules;
  /** Per-directory accumulated rules (root + each ancestor's nested .gitignore),
   *  memoized so a burst of events in one directory reads each .gitignore once. */
  private readonly rulesByDir = new Map<string, IgnoreRules>();

  constructor(
    private readonly root: string,
    private readonly onChange: (rel: string) => void,
    options: FileWatcherOptions = {},
  ) {
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? MAX_FILE_SIZE_BYTES;
    this.source = options.source ?? fsWatchSource;
    this.ignoreRules = loadIgnoreRules(root);
  }

  start(): void {
    if (this.subscription) return;
    this.subscription = this.source(this.root, (rel) => this.handle(rel));
  }

  close(): void {
    this.subscription?.close();
    this.subscription = undefined;
  }

  /** Ignore rules in effect inside `dirRel`: the root rules plus every ancestor
   *  directory's nested .gitignore, each rebased to its directory, so a changed
   *  file is judged exactly as the discovery walk would (ama-pyk). Memoized per
   *  directory; like the root rules, a .gitignore edited after start isn't
   *  reloaded — restart the watcher for that. (ama-ezf) */
  private rulesForDir(dirRel: string): IgnoreRules {
    if (dirRel === "" || dirRel === ".") return this.ignoreRules;
    const cached = this.rulesByDir.get(dirRel);
    if (cached) return cached;
    const parent = path.dirname(dirRel);
    const rules = withNestedIgnore(
      path.join(this.root, dirRel),
      dirRel,
      this.rulesForDir(parent === "." ? "" : parent),
    );
    this.rulesByDir.set(dirRel, rules);
    return rules;
  }

  private handle(rel: string): void {
    const dir = path.dirname(rel);
    if (isIgnoredPath(rel, this.rulesForDir(dir === "." ? "" : dir))) return;
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
