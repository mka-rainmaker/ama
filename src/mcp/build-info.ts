import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A stamp identifying the running server build, surfaced on `index_status` so a
 * caller (e.g. the self-improvement loop's Step 0) can detect a stale server —
 * one started before the latest commit. It is captured ONCE at module load, so
 * `revision` reflects the code the process was launched with, not live HEAD: if
 * you commit without restarting, the stamp lags HEAD and the staleness shows.
 */
export interface ServerStamp {
  /** Package version from package.json. */
  version: string;
  /** Git HEAD revision at server start, or null when run outside a git repo. */
  revision: string | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// src/mcp/build-info.ts and dist/mcp/build-info.js both sit two levels under
// the repo root, so the same relative hop finds package.json and .git either way.
const repoRoot = path.resolve(here, "../..");

function readVersion(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Resolve HEAD to a commit SHA from the filesystem (loose ref, then packed-refs). */
function readRevision(root: string): string | null {
  try {
    const gitDir = path.join(root, ".git");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*(.+)$/)?.[1];
    if (!ref) {
      // Detached HEAD: the HEAD file holds the SHA directly.
      return /^[0-9a-f]{40}$/.test(head) ? head : null;
    }
    try {
      const loose = fs.readFileSync(path.join(gitDir, ref), "utf8").trim();
      if (/^[0-9a-f]{40}$/.test(loose)) return loose;
    } catch {
      // No loose ref file — fall through to packed-refs.
    }
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, name] = line.split(" ");
      if (name === ref && sha) return sha;
    }
    return null;
  } catch {
    return null;
  }
}

/** Captured once at module load — the code the running server was started with. */
export const serverStamp: ServerStamp = {
  version: readVersion(repoRoot),
  revision: readRevision(repoRoot),
};
