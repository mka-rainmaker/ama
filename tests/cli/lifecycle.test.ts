import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { indexCommand, initCommand, uninitCommand } from "../../src/cli/commands/lifecycle.js";
import { COMMANDS } from "../../src/cli/index.js";
import type { IndexStatus } from "../../src/mcp/session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "../fixtures/ts-typealias");

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("index lifecycle commands", () => {
  const tmpDirs: string[] = [];
  const savedDb = process.env.AMA_DB;

  /** Point AMA_DB at a brand-new temp `.ama/index.db` and return its path. */
  function freshDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-life-"));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, ".ama", "index.db");
    process.env.AMA_DB = dbPath;
    return dbPath;
  }

  afterEach(() => {
    if (savedDb === undefined) Reflect.deleteProperty(process.env, "AMA_DB");
    else process.env.AMA_DB = savedDb;
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("index builds a persistent index and reports its counts", async () => {
    const dbPath = freshDb();
    const out = capture();
    const code = await indexCommand.run([fixtureRoot], { json: true, write: out.write });
    expect(code).toBe(0);
    const status = JSON.parse(out.text()) as IndexStatus;
    expect(status.indexed).toBe(true);
    if (status.indexed) expect(status.nodeCount).toBeGreaterThan(0);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("index rebuilds in place when an index already exists", async () => {
    freshDb();
    await indexCommand.run([fixtureRoot], { json: true, write: () => {} });
    const out = capture();
    const code = await indexCommand.run([fixtureRoot], { json: true, write: out.write });
    expect(code).toBe(0);
    expect((JSON.parse(out.text()) as IndexStatus).indexed).toBe(true);
  });

  it("init builds the index when none exists", async () => {
    const dbPath = freshDb();
    const out = capture();
    await initCommand.run([fixtureRoot], { json: true, write: out.write });
    const status = JSON.parse(out.text()) as IndexStatus;
    expect(status.indexed).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("init does not rebuild when an index already exists", async () => {
    freshDb();
    await indexCommand.run([fixtureRoot], { json: true, write: () => {} });
    const out = capture();
    const code = await initCommand.run([fixtureRoot], { json: true, write: out.write });
    expect(code).toBe(0);
    expect(JSON.parse(out.text()).alreadyInitialized).toBe(true);
  });

  it("uninit removes an existing index", async () => {
    const dbPath = freshDb();
    await indexCommand.run([fixtureRoot], { json: true, write: () => {} });
    expect(fs.existsSync(dbPath)).toBe(true);
    const out = capture();
    const code = await uninitCommand.run([fixtureRoot], { json: true, write: out.write });
    expect(code).toBe(0);
    expect(JSON.parse(out.text()).removed).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("uninit is a no-op when there is no index", async () => {
    const dbPath = freshDb();
    const out = capture();
    const code = await uninitCommand.run([fixtureRoot], { json: true, write: out.write });
    expect(code).toBe(0);
    expect(JSON.parse(out.text()).removed).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});

describe("CLI command registration", () => {
  it("registers init, index, and uninit alongside status", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(["init", "index", "uninit", "status"]));
  });
});
