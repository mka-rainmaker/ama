import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { renderStatus, statusCommand } from "../../src/cli/commands/status.js";
import { COMMANDS } from "../../src/cli/index.js";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";
import type { IndexStatus } from "../../src/mcp/session.js";
import { SqliteStore } from "../../src/store/sqlite.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REVISION = "f14c737aa746d46e36b1c89c263502328ed6e1d9";

const INDEXED: IndexStatus = {
  indexed: true,
  root: "/repo",
  nodeCount: 479,
  edgeCount: 1185,
  fileCount: 71,
  languages: [{ language: "typescript", tier: "deep", files: 71 }],
  pendingSync: 0,
  server: { version: "0.0.1", revision: REVISION },
};

const NOT_INDEXED: IndexStatus = {
  indexed: false,
  server: { version: "0.0.1", revision: REVISION },
};

describe("renderStatus", () => {
  it("reports counts, language coverage, and tier in human form", () => {
    const text = renderStatus(INDEXED, false);
    expect(text).toContain("71");
    expect(text).toContain("479");
    expect(text).toContain("1185");
    expect(text).toContain("typescript");
    expect(text).toContain("deep");
    expect(text.toLowerCase()).toContain("pending");
  });

  it("guides the user to build an index when nothing is indexed", () => {
    const text = renderStatus(NOT_INDEXED, false);
    expect(text.toLowerCase()).toContain("no index");
    expect(text).toContain("ama index");
  });

  it("emits the raw status object verbatim as JSON when json=true", () => {
    expect(JSON.parse(renderStatus(INDEXED, true))).toEqual(INDEXED);
    expect(JSON.parse(renderStatus(NOT_INDEXED, true))).toEqual(NOT_INDEXED);
  });

  it("renders a null revision (no git) as 'unknown' instead of throwing", () => {
    const noGit: IndexStatus = { indexed: false, server: { version: "0.0.1", revision: null } };
    const text = renderStatus(noGit, false);
    expect(text).toContain("unknown");
    expect(text).not.toContain("null");
  });
});

describe("status command", () => {
  const tmpDirs: string[] = [];
  const savedDb = process.env.AMA_DB;

  afterEach(() => {
    if (savedDb === undefined) Reflect.deleteProperty(process.env, "AMA_DB");
    else process.env.AMA_DB = savedDb;
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("reports the real counts of a persisted index", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-status-"));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, "index.db");
    const fixtureRoot = path.resolve(here, "../fixtures/ts-typealias");

    const indexer = createDefaultIndexer(() => new SqliteStore(dbPath));
    const { store, stats } = await indexer.index(fixtureRoot);
    store.close();

    process.env.AMA_DB = dbPath;
    const lines: string[] = [];
    const code = await statusCommand.run([fixtureRoot], {
      json: true,
      write: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as IndexStatus;
    expect(parsed.indexed).toBe(true);
    if (parsed.indexed) {
      expect(parsed.nodeCount).toBe(stats.nodeCount);
      expect(parsed.fileCount).toBe(stats.fileCount);
      expect(parsed.pendingSync).toBe(0);
    }
  });

  it("reports not-indexed when the db is absent (without creating it)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-status-"));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, "missing.db");
    process.env.AMA_DB = dbPath;

    const lines: string[] = [];
    const code = await statusCommand.run([dir], {
      json: true,
      write: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n")).indexed).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});

describe("CLI command registration", () => {
  it("registers status in the command table", () => {
    expect(COMMANDS.map((command) => command.name)).toContain("status");
  });
});
