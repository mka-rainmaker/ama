import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { fingerprint, isStale } from "../../src/indexer/indexer.js";
import type { FileMeta } from "../../src/store/types.js";

const root = os.tmpdir();
const gone = "ama-definitely-not-a-real-file-7r5.ts";

/**
 * A file present at discovery but gone microseconds later — an editor's atomic
 * save or a temp file in the watch path — must not crash the index. fingerprint
 * returns null (the caller drops it); isStale counts it as stale so reindexFile
 * reconciles the removal. (ama-7r5)
 */
describe("indexer tolerates a file that vanishes mid-index/sync (ama-7r5)", () => {
  it("fingerprint returns null for a missing file instead of throwing", () => {
    expect(fingerprint(root, gone)).toBeNull();
  });

  it("isStale treats a missing file as stale (so it gets reconciled away)", () => {
    const meta: FileMeta = { path: gone, size: 1, mtimeMs: 1, hash: "x" };
    expect(isStale(root, gone, meta)).toBe(true);
  });
});
