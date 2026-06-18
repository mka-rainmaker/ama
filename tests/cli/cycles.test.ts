import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cyclesCommand } from "../../src/cli/commands/cycles.js";
import { indexCommand } from "../../src/cli/commands/lifecycle.js";
import { COMMANDS } from "../../src/cli/index.js";
import type { GraphNode } from "../../src/graph/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cycleRoot = path.resolve(here, "../fixtures/ts-cycle");

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("cycles CLI command", () => {
  const tmpDirs: string[] = [];
  const saved = { AMA_DB: process.env.AMA_DB, AMA_ROOT: process.env.AMA_ROOT };

  async function indexCycle(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-cycles-"));
    tmpDirs.push(dir);
    process.env.AMA_DB = path.join(dir, ".ama", "index.db");
    process.env.AMA_ROOT = cycleRoot;
    await indexCommand.run([cycleRoot], { json: true, write: () => {} });
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

  it("lists a file-level import cycle as JSON", async () => {
    await indexCycle();
    const out = capture();
    const code = await cyclesCommand.run([], { json: true, write: out.write });
    expect(code).toBe(0);
    const cycles = JSON.parse(out.text()) as GraphNode[][];
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.map((n) => n.file).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("renders the cycle for the terminal", async () => {
    await indexCycle();
    const out = capture();
    await cyclesCommand.run([], { json: false, write: out.write });
    expect(out.text()).toContain("a.ts");
    expect(out.text()).toContain("b.ts");
  });

  it("is registered in the command list", () => {
    expect(COMMANDS.map((c) => c.name)).toContain("cycles");
  });
});
