import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FileWatcher, type WatchSource } from "../../src/indexer/watcher.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/gitignore-nested");

/**
 * The watcher loaded only the root .gitignore, so a changed file under a nested-
 * ignored directory was still reported (and re-indexed) — breaking the "watch set
 * matches index set" invariant the discovery walk now honors. (ama-ezf)
 */
describe("watcher honors nested .gitignore for changed files (ama-ezf)", () => {
  it("drops a nested-ignored change but keeps a non-ignored sibling", () => {
    let emit: ((rel: string) => void) | undefined;
    const source: WatchSource = (_root, onEvent) => {
      emit = onEvent;
      return { close: () => {} };
    };
    const changes: string[] = [];
    const watcher = new FileWatcher(root, (rel) => changes.push(rel), { source });
    watcher.start();

    emit?.("pkg/keep.ts"); // not ignored → reported
    emit?.("pkg/secret.ts"); // pkg/.gitignore `secret.ts` → ignored
    emit?.("pkg/sub/anchored.ts"); // pkg `/anchored.ts` is dir-root only → reported
    watcher.close();

    expect(changes).toContain("pkg/keep.ts");
    expect(changes).toContain("pkg/sub/anchored.ts");
    expect(changes).not.toContain("pkg/secret.ts");
  });
});
