import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AmaSession } from "../../src/mcp/session.js";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-coverage-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * index_status's per-language `languages` census was written only by a full
 * index, so an incremental sync left it stale (it showed the old language set
 * even after files of a new language were added). Recomputing it live from the
 * store keeps it correct on every path. (ama-okg)
 */
describe("index_status coverage stays live after a sync (ama-okg)", () => {
  it("reflects a file of a new language added after the initial index", async () => {
    fs.writeFileSync(path.join(dir, "a.ts"), "export const x = 1;\n");
    const session = new AmaSession();
    await session.indexRepository(dir);
    const before = session.indexStatus();
    expect(before.indexed && before.languages.map((l) => l.language)).toEqual(["typescript"]);

    // Add a Python file and reconcile via sync — the census must pick it up.
    fs.writeFileSync(path.join(dir, "b.py"), "def f():\n    pass\n");
    await session.sync();
    const after = session.indexStatus();
    const langs = after.indexed ? after.languages.map((l) => l.language).sort() : [];
    expect(langs).toEqual(["python", "typescript"]);
    session.close();
  });
});
