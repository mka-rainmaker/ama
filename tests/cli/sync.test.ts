import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexCommand } from "../../src/cli/commands/lifecycle.js";
import { searchCommand } from "../../src/cli/commands/search.js";
import { renderSync, syncCommand } from "../../src/cli/commands/sync.js";
import { COMMANDS } from "../../src/cli/index.js";
import type { SyncResult } from "../../src/indexer/indexer.js";

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("renderSync", () => {
  it("reports an unchanged index as up to date", () => {
    expect(renderSync({ changed: [], removed: [] }, false).toLowerCase()).toContain("up to date");
  });

  it("lists changed and removed files in human form", () => {
    const text = renderSync({ changed: ["src/a.ts"], removed: ["src/old.ts"] }, false);
    expect(text).toContain("1 changed");
    expect(text).toContain("1 removed");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("src/old.ts");
  });

  it("emits the raw SyncResult as JSON when json=true", () => {
    const result: SyncResult = { changed: ["a.ts"], removed: ["gone.ts"] };
    expect(JSON.parse(renderSync(result, true))).toEqual(result);
  });
});

describe("sync command", () => {
  const tmpDirs: string[] = [];
  const saved = { AMA_DB: process.env.AMA_DB, AMA_ROOT: process.env.AMA_ROOT };

  /** A temp project with two source files; AMA_DB/AMA_ROOT point at it. */
  function project(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-sync-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "a.ts"), "export function a() {}\n");
    fs.writeFileSync(path.join(dir, "b.ts"), "export function b() {}\n");
    process.env.AMA_DB = path.join(dir, ".ama", "index.db");
    process.env.AMA_ROOT = dir;
    return dir;
  }

  async function build(dir: string): Promise<void> {
    await indexCommand.run([dir], { json: true, write: () => {} });
  }

  afterEach(() => {
    for (const key of ["AMA_DB", "AMA_ROOT"] as const) {
      const value = saved[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("is a no-op when nothing changed on disk", async () => {
    const dir = project();
    await build(dir);
    const out = capture();
    const code = await syncCommand.run([dir], { json: true, write: out.write });
    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toEqual({ changed: [], removed: [] });
  });

  it("re-indexes only the files that changed", async () => {
    const dir = project();
    await build(dir);
    fs.appendFileSync(path.join(dir, "a.ts"), "export function a2() {}\n");
    const out = capture();
    await syncCommand.run([dir], { json: true, write: out.write });
    const result = JSON.parse(out.text()) as SyncResult;
    expect(result.changed).toContain("a.ts");
    expect(result.changed).not.toContain("b.ts");
    expect(result.removed).toEqual([]);
  });

  it("drops files deleted from disk", async () => {
    const dir = project();
    await build(dir);
    fs.rmSync(path.join(dir, "b.ts"));
    const out = capture();
    await syncCommand.run([dir], { json: true, write: out.write });
    expect((JSON.parse(out.text()) as SyncResult).removed).toContain("b.ts");
  });

  it("makes a newly added symbol queryable (end-to-end with search)", async () => {
    const dir = project();
    await build(dir);
    fs.appendFileSync(path.join(dir, "a.ts"), "export function freshlyAdded() {}\n");
    await syncCommand.run([dir], { json: true, write: () => {} });
    const out = capture();
    await searchCommand.run(["freshlyAdded"], { json: true, write: out.write });
    const hits = JSON.parse(out.text()) as { name: string }[];
    expect(hits.some((n) => n.name === "freshlyAdded")).toBe(true);
  });

  it("fails with exit 1 when no index exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-sync-"));
    tmpDirs.push(dir);
    process.env.AMA_DB = path.join(dir, ".ama", "missing.db");
    const out = capture();
    const code = await syncCommand.run([dir], { json: false, write: out.write });
    expect(code).toBe(1);
    expect(out.text().toLowerCase()).toContain("no index");
  });
});

describe("CLI command registration", () => {
  it("registers sync", () => {
    expect(COMMANDS.map((command) => command.name)).toContain("sync");
  });
});
