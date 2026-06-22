import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_SIZE_BYTES } from "../../src/indexer/ignore.js";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";

/**
 * Files over the parse cap (minified bundles, data blobs) are skipped before parsing.
 * The skip must be reported, not silent — the same "never silently dropped" rule the
 * per-analyzer isolation follows, so a user knows a file was omitted. (ama-j0y)
 */
describe("oversized files are skipped, but reported (ama-j0y)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-large-"));
    fs.writeFileSync(
      path.join(dir, "small.ts"),
      "export function ok(): number {\n  return 1;\n}\n",
    );
    // A file just over the cap — a stand-in for a minified bundle / generated blob.
    fs.writeFileSync(
      path.join(dir, "huge.ts"),
      `export const blob = "${"x".repeat(MAX_FILE_SIZE_BYTES + 1)}";\n`,
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("logs the skipped oversized file to stderr and still indexes the rest", async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const { store } = await createDefaultIndexer().index(dir);
    spy.mockRestore();

    // The oversized file is reported by name (never silently dropped) ...
    expect(errs.some((e) => e.includes("huge.ts"))).toBe(true);
    // ... while normal files still index.
    const indexed = store.allFiles().map((f) => f.path);
    expect(indexed).toContain("small.ts");
    expect(indexed).not.toContain("huge.ts");
  });
});
