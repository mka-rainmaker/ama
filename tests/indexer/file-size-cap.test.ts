import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";

describe("Indexer file-size cap on discovery (ama-m8k.8)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("skips a file larger than the cap during initial discovery, matching the watcher", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-size-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "small.ts"), "export const x = 1;\n");
    // A >1 MB source file (a minified bundle / data blob). Valid TS — a big string.
    fs.writeFileSync(
      path.join(dir, "huge.ts"),
      `export const BLOB = "${"x".repeat(1_200_000)}";\n`,
    );

    const { store, stats } = await createDefaultIndexer().index(dir);
    const files = store.allFiles().map((f) => f.path);
    expect(files).toContain("small.ts");
    expect(files).not.toContain("huge.ts");
    expect(stats.fileCount).toBe(1);
  });
});
