import * as fs from "node:fs";
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

/** Resolved ignore patterns for one root: exact segment names and name globs. */
export interface IgnoreRules {
  /** Dir/file names ignored at any depth (IGNORED_DIRS + .gitignore bare names). */
  names: Set<string>;
  /** Name globs from .gitignore (e.g. `*.gen.ts`), each anchored to a full segment. */
  globs: RegExp[];
  /** Root-anchored patterns (a leading or embedded slash, e.g. `/build`,
   *  `pkg/internal`), matched against the full repo-relative path. (ama-yhu) */
  anchored: RegExp[];
}

/** The built-in ignores, used when no `.gitignore` has been loaded. */
export const BASE_IGNORE_RULES: IgnoreRules = { names: IGNORED_DIRS, globs: [], anchored: [] };

/** A gitignore name glob (`*.ext`, `build-*`) as a whole-segment regex. (ama-2eu) */
function globToSegmentRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${body}$`);
}

/** A root-anchored gitignore pattern (`build`, `pkg/internal`, `src/*.gen.ts` —
 *  with any leading/trailing slash already stripped) as a regex over the full
 *  repo-relative (posix) path, matching the entry and everything under it. `*`/`?`
 *  stay within a path segment; `**` is not modelled (those lines are skipped at
 *  load). (ama-yhu) */
function anchoredToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${body}(?:/|$)`);
}

/**
 * Read `<root>/.gitignore` and fold a *safe subset* of its patterns into the
 * built-in ignores. Blank lines and `#` comments are skipped; so are patterns we
 * don't fully model — `!` negations, embedded-`/` paths, and `**`. Skipping an
 * unsupported pattern only ever indexes *more*, never less, so a misread can
 * never silently drop a file. A bare `name`/`name/` ignores that segment at any
 * depth; a glob like `*.ext` matches a segment. (ama-2eu)
 */
export function loadIgnoreRules(root: string): IgnoreRules {
  const names = new Set(IGNORED_DIRS);
  const globs: RegExp[] = [];
  const anchored: RegExp[] = [];
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  } catch {
    return { names, globs, anchored };
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // Skip blanks, comments, `!` negations, and `**` deep globs — none modelled.
    // Skipping a pattern only ever indexes *more*, never less, so a file is never
    // wrongly dropped; negations and nested .gitignore remain a follow-up. (ama-yhu)
    if (!line || line.startsWith("#") || line.startsWith("!") || line.includes("**")) continue;
    const body = line.replace(/\/+$/, ""); // a trailing slash only marks dir-only
    if (!body) continue;
    if (body.includes("/")) {
      // A leading or embedded slash anchors the pattern to this .gitignore's
      // directory (the root) — match it root-relatively, not at any depth. (ama-yhu)
      anchored.push(anchoredToRegExp(body.replace(/^\/+/, "")));
    } else if (/[*?]/.test(body)) {
      globs.push(globToSegmentRegExp(body));
    } else {
      names.add(body);
    }
  }
  return { names, globs, anchored };
}

/** Whether a single path segment (a file or directory name) is ignored. */
export function isIgnoredSegment(name: string, rules: IgnoreRules = BASE_IGNORE_RULES): boolean {
  return name.startsWith(".") || rules.names.has(name) || rules.globs.some((re) => re.test(name));
}

/** Whether a repo-relative path is ignored: any segment matches an any-depth
 *  name/glob, or the full path matches a root-anchored pattern. (ama-yhu) */
export function isIgnoredPath(rel: string, rules: IgnoreRules = BASE_IGNORE_RULES): boolean {
  const segments = rel.split(path.sep);
  if (segments.some((seg) => isIgnoredSegment(seg, rules))) return true;
  if (rules.anchored.length === 0) return false;
  const posix = segments.join("/");
  return rules.anchored.some((re) => re.test(posix));
}
