import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { indexCommand } from "../../src/cli/commands/lifecycle.js";
import {
  parseSearchArgs,
  renderSearch,
  searchCodeCommand,
  searchCommand,
} from "../../src/cli/commands/search.js";
import { COMMANDS } from "../../src/cli/index.js";
import type { GraphNode } from "../../src/graph/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "../fixtures/ts-typealias");

const NODES: GraphNode[] = [
  {
    id: "src/a.ts#Status",
    kind: "TypeAlias",
    name: "Status",
    file: "src/a.ts",
    qualifiedName: "Status",
    range: { startLine: 3, endLine: 3 },
    tier: "deep",
  },
];

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("parseSearchArgs", () => {
  it("reads the query, --kind, and --limit", () => {
    expect(parseSearchArgs(["Status", "--kind", "TypeAlias", "--limit", "10"])).toEqual({
      query: "Status",
      kind: "TypeAlias",
      limit: 10,
    });
  });

  it("rejects an unknown --kind", () => {
    expect(parseSearchArgs(["x", "--kind", "Bogus"]).error).toMatch(/kind/i);
  });

  it("rejects a non-positive --limit", () => {
    expect(parseSearchArgs(["x", "--limit", "0"]).error).toMatch(/limit/i);
    expect(parseSearchArgs(["x", "--limit", "abc"]).error).toMatch(/limit/i);
  });

  it("rejects an unknown flag", () => {
    expect(parseSearchArgs(["x", "--nope"]).error).toMatch(/--nope/);
  });
});

describe("renderSearch", () => {
  it("lists each hit with kind, name, location, and tier in human form", () => {
    const text = renderSearch("Status", NODES, false);
    expect(text).toContain("TypeAlias");
    expect(text).toContain("Status");
    expect(text).toContain("src/a.ts:3");
    expect(text).toContain("deep");
  });

  it("reports no matches when the result set is empty", () => {
    expect(renderSearch("nope", [], false).toLowerCase()).toContain("no symbols match");
  });

  it("emits the raw node array as JSON when json=true", () => {
    expect(JSON.parse(renderSearch("Status", NODES, true))).toEqual(NODES);
  });
});

describe("search command", () => {
  const tmpDirs: string[] = [];
  const savedDb = process.env.AMA_DB;
  const savedRoot = process.env.AMA_ROOT;

  function freshIndexedDb(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-search-"));
    tmpDirs.push(dir);
    process.env.AMA_DB = path.join(dir, ".ama", "index.db");
    process.env.AMA_ROOT = fixtureRoot;
  }

  afterEach(() => {
    for (const [key, saved] of [
      ["AMA_DB", savedDb],
      ["AMA_ROOT", savedRoot],
    ] as const) {
      if (saved === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = saved;
    }
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("finds a symbol in the persisted index", async () => {
    freshIndexedDb();
    await indexCommand.run([fixtureRoot], { json: true, write: () => {} });
    const out = capture();
    const code = await searchCommand.run(["Status"], { json: true, write: out.write });
    expect(code).toBe(0);
    const hits = JSON.parse(out.text()) as GraphNode[];
    expect(hits.some((n) => n.name === "Status")).toBe(true);
  });

  it("applies the --kind filter", async () => {
    freshIndexedDb();
    await indexCommand.run([fixtureRoot], { json: true, write: () => {} });
    const out = capture();
    await searchCommand.run(["Status", "--kind", "Class"], { json: true, write: out.write });
    expect(JSON.parse(out.text())).toEqual([]);
  });

  it("fails with exit 1 when no index exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-search-"));
    tmpDirs.push(dir);
    process.env.AMA_DB = path.join(dir, ".ama", "missing.db");
    process.env.AMA_ROOT = fixtureRoot;
    const out = capture();
    const code = await searchCommand.run(["Status"], { json: false, write: out.write });
    expect(code).toBe(1);
    expect(out.text().toLowerCase()).toContain("no index");
  });

  it("fails with exit 1 on a usage error (missing query)", async () => {
    const out = capture();
    const code = await searchCommand.run([], { json: false, write: out.write });
    expect(code).toBe(1);
    expect(out.text().toLowerCase()).toContain("usage");
  });

  it("routes the usage error to stderr when an error sink is provided", async () => {
    const out = capture();
    const err = capture();
    const code = await searchCommand.run([], {
      json: false,
      write: out.write,
      error: err.write,
    });
    expect(code).toBe(1);
    expect(err.text().toLowerCase()).toContain("usage");
    expect(out.text()).toBe("");
  });
});

describe("search-code command", () => {
  const tmpDirs: string[] = [];
  const saved = { AMA_DB: process.env.AMA_DB, AMA_ROOT: process.env.AMA_ROOT };

  afterEach(() => {
    for (const key of ["AMA_DB", "AMA_ROOT"] as const) {
      const value = saved[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("finds symbols whose body text contains the query", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-searchcode-"));
    tmpDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "m.ts"),
      'export function magic(): string {\n  return "ABRACADABRA";\n}\n' +
        "export function other(): number {\n  return 1;\n}\n",
    );
    process.env.AMA_DB = path.join(dir, ".ama", "index.db");
    process.env.AMA_ROOT = dir;
    await indexCommand.run([dir], { json: true, write: () => {} });

    const out = capture();
    const code = await searchCodeCommand.run(["ABRACADABRA"], { json: true, write: out.write });
    expect(code).toBe(0);
    const names = (JSON.parse(out.text()) as GraphNode[]).map((n) => n.name);
    expect(names).toContain("magic");
    expect(names).not.toContain("other");
  });

  it("fails with exit 1 on an empty query", async () => {
    const out = capture();
    const code = await searchCodeCommand.run([], { json: false, write: out.write });
    expect(code).toBe(1);
    expect(out.text().toLowerCase()).toContain("usage");
  });
});

describe("CLI command registration", () => {
  it("registers search and search-code", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(names).toContain("search");
    expect(names).toContain("search-code");
  });
});
