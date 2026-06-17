import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  affectedCommand,
  impactCommand,
  parseImpactArgs,
  renderAffected,
} from "../../src/cli/commands/impact.js";
import { indexCommand } from "../../src/cli/commands/lifecycle.js";
import { COMMANDS } from "../../src/cli/index.js";
import type { GraphNode } from "../../src/graph/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const callsRoot = path.resolve(here, "../fixtures/ts-calls");

const NODE: GraphNode = {
  id: "b.ts#b",
  kind: "Function",
  name: "b",
  file: "b.ts",
  qualifiedName: "b",
  range: { startLine: 1, endLine: 1 },
  tier: "deep",
};

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("parseImpactArgs", () => {
  it("reads the ref and an optional --depth", () => {
    expect(parseImpactArgs(["helper", "--depth", "2"])).toEqual({ ref: "helper", depth: 2 });
    expect(parseImpactArgs(["helper"])).toEqual({ ref: "helper" });
  });

  it("rejects a non-positive --depth", () => {
    expect(parseImpactArgs(["x", "--depth", "0"]).error).toMatch(/depth/i);
    expect(parseImpactArgs(["x", "--depth", "abc"]).error).toMatch(/depth/i);
  });

  it("rejects an unknown flag", () => {
    expect(parseImpactArgs(["x", "--nope"]).error).toMatch(/--nope/);
  });
});

describe("renderAffected", () => {
  it("names the subject files and lists impacted symbols", () => {
    const text = renderAffected(["a.ts"], [NODE], false);
    expect(text).toContain("a.ts");
    expect(text).toContain("b");
  });

  it("reports nothing affected when the list is empty", () => {
    expect(renderAffected(["a.ts"], [], false).toLowerCase()).toContain("nothing");
  });

  it("emits the raw node array as JSON", () => {
    expect(JSON.parse(renderAffected(["a.ts"], [NODE], true))).toEqual([NODE]);
  });
});

describe("impact command", () => {
  const tmpDirs: string[] = [];
  const saved = { AMA_DB: process.env.AMA_DB, AMA_ROOT: process.env.AMA_ROOT };

  async function indexCalls(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-impact-"));
    tmpDirs.push(dir);
    process.env.AMA_DB = path.join(dir, ".ama", "index.db");
    process.env.AMA_ROOT = callsRoot;
    await indexCommand.run([callsRoot], { json: true, write: () => {} });
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

  it("reports the transitive blast radius of a symbol", async () => {
    await indexCalls();
    const out = capture();
    const code = await impactCommand.run(["helper"], { json: true, write: out.write });
    expect(code).toBe(0);
    const names = (JSON.parse(out.text()) as GraphNode[]).map((n) => n.name);
    expect(names).toContain("main"); // main -> helper
    expect(names).toContain("run"); // run -> compute -> helper (transitive)
  });

  it("bounds the blast radius with --depth", async () => {
    await indexCalls();
    const out = capture();
    await impactCommand.run(["helper", "--depth", "1"], { json: true, write: out.write });
    const names = (JSON.parse(out.text()) as GraphNode[]).map((n) => n.name);
    expect(names).toContain("compute"); // direct caller
    expect(names).not.toContain("run"); // two hops away — excluded at depth 1
  });

  it("fails with exit 1 when no index exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-impact-"));
    tmpDirs.push(dir);
    process.env.AMA_DB = path.join(dir, ".ama", "missing.db");
    process.env.AMA_ROOT = callsRoot;
    const out = capture();
    const code = await impactCommand.run(["helper"], { json: false, write: out.write });
    expect(code).toBe(1);
    expect(out.text().toLowerCase()).toContain("no index");
  });

  it("fails with exit 1 on a missing ref", async () => {
    const out = capture();
    const code = await impactCommand.run([], { json: false, write: out.write });
    expect(code).toBe(1);
    expect(out.text().toLowerCase()).toContain("usage");
  });
});

describe("affected command", () => {
  const tmpDirs: string[] = [];
  const saved = { AMA_DB: process.env.AMA_DB, AMA_ROOT: process.env.AMA_ROOT };

  /** Temp project where b.ts imports a.ts; AMA_DB/AMA_ROOT point at it. */
  async function indexImports(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-affected-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "a.ts"), "export function a(): number {\n  return 1;\n}\n");
    fs.writeFileSync(
      path.join(dir, "b.ts"),
      'import { a } from "./a.js";\nexport function b(): number {\n  return a();\n}\n',
    );
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

  it("finds files impacted by a change to a given file", async () => {
    await indexImports();
    const out = capture();
    const code = await affectedCommand.run(["a.ts"], { json: true, write: out.write });
    expect(code).toBe(0);
    const files = (JSON.parse(out.text()) as GraphNode[]).map((n) => n.file);
    expect(files).toContain("b.ts"); // b imports a, so changing a affects b
  });

  it("fails with exit 1 when no files are given", async () => {
    const out = capture();
    const code = await affectedCommand.run([], { json: false, write: out.write });
    expect(code).toBe(1);
    expect(out.text().toLowerCase()).toContain("usage");
  });
});

describe("CLI command registration", () => {
  it("registers impact and affected", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(["impact", "affected"]));
  });
});
