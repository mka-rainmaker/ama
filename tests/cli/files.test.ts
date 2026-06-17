import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filesCommand, renderFiles } from "../../src/cli/commands/files.js";
import { indexCommand } from "../../src/cli/commands/lifecycle.js";
import { COMMANDS } from "../../src/cli/index.js";
import type { FileMeta } from "../../src/store/types.js";

const FILES: FileMeta[] = [
  { path: "src/a.ts", size: 10, mtimeMs: 1, hash: "h1" },
  { path: "src/b.ts", size: 20, mtimeMs: 2, hash: "h2" },
];

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("renderFiles", () => {
  it("lists each path under a count header", () => {
    const text = renderFiles(FILES, undefined, false);
    expect(text).toContain("src/a.ts");
    expect(text).toContain("src/b.ts");
    expect(text).toContain("2");
  });

  it("reports an empty index", () => {
    expect(renderFiles([], undefined, false).toLowerCase()).toContain("no indexed files");
  });

  it("names the filter when nothing matches", () => {
    const text = renderFiles([], "zzz", false);
    expect(text.toLowerCase()).toContain("no files match");
    expect(text).toContain("zzz");
  });

  it("emits the raw FileMeta array as JSON when json=true", () => {
    expect(JSON.parse(renderFiles(FILES, undefined, true))).toEqual(FILES);
  });
});

describe("files command", () => {
  const tmpDirs: string[] = [];
  const saved = { AMA_DB: process.env.AMA_DB, AMA_ROOT: process.env.AMA_ROOT };

  /** A temp project with files at the root and in a subdirectory. */
  async function indexProject(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-files-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "a.ts"), "export function a() {}\n");
    fs.writeFileSync(path.join(dir, "b.ts"), "export function b() {}\n");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "c.ts"), "export function c() {}\n");
    process.env.AMA_DB = path.join(dir, ".ama", "index.db");
    process.env.AMA_ROOT = dir;
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

  it("lists every indexed file", async () => {
    await indexProject();
    const out = capture();
    const code = await filesCommand.run([], { json: true, write: out.write });
    expect(code).toBe(0);
    const paths = (JSON.parse(out.text()) as FileMeta[]).map((f) => f.path);
    expect(paths).toContain("a.ts");
    expect(paths).toContain("b.ts");
    expect(paths).toContain("sub/c.ts");
  });

  it("filters by a path substring", async () => {
    await indexProject();
    const out = capture();
    const code = await filesCommand.run(["sub"], { json: true, write: out.write });
    expect(code).toBe(0);
    const paths = (JSON.parse(out.text()) as FileMeta[]).map((f) => f.path);
    expect(paths).toEqual(["sub/c.ts"]);
  });

  it("fails with exit 1 when no index exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-files-"));
    tmpDirs.push(dir);
    process.env.AMA_DB = path.join(dir, ".ama", "missing.db");
    process.env.AMA_ROOT = dir;
    const out = capture();
    const code = await filesCommand.run([], { json: false, write: out.write });
    expect(code).toBe(1);
    expect(out.text().toLowerCase()).toContain("no index");
  });
});

describe("CLI command registration", () => {
  it("registers files", () => {
    expect(COMMANDS.map((command) => command.name)).toContain("files");
  });
});
